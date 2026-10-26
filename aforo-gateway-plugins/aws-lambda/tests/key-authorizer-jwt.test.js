/**
 * Tests for the client-credential JWT path of key-authorizer.js.
 * Run with: node tests/key-authorizer-jwt.test.js
 *
 * An RSA key pair is generated here and served as a JWKS through a stubbed
 * global fetch, so nothing leaves the process.
 */
'use strict';

const crypto = require('crypto');

process.env.AFORO_TENANT_KEY = 'sk_live_tenant_test_key';
process.env.AFORO_TENANT_ID = 'tenant-42';
process.env.AFORO_JWKS_URL = 'https://jwks.test/.well-known/jwks.json';
process.env.CACHE_TTL_MS = '60000';

const ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/POST/mcp';
const ISS = 'https://auth.aforo.ai';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'aforo-v1', use: 'sig', alg: 'RS256' };

// ── fetch stub ──
const fetchStub = { calls: 0, fail: 0, keys: [jwk] };
global.fetch = async (url) => {
    fetchStub.calls++;
    if (fetchStub.fail > 0) { fetchStub.fail--; throw new Error('connect ECONNREFUSED'); }
    return { ok: true, status: 200, json: async () => ({ keys: fetchStub.keys }) };
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { kid = 'aforo-v1', alg = 'RS256', key = privateKey } = {}) {
    const h = b64({ alg, kid, typ: 'JWT' });
    const p = b64(claims);
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `${h}.${p}.${s}`;
}
const now = () => Math.floor(Date.now() / 1000);
function claims(over = {}) {
    return {
        sub: 'cust-1', iss: ISS, iat: now(), exp: now() + 900, jti: crypto.randomUUID(),
        tenant_id: 'tenant-42', customer_id: 'cust-1', key_id: 'key-9', client_id: 'cl_1',
        offering_ids: ['off-1'], subscription_ids: ['sub-1'], scopes: 'usage:read', environment: 'LIVE',
        ...over,
    };
}

let passed = 0;
let failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); } }
function assertEquals(a, e, msg) {
    assert(a === e, a === e ? msg : `${msg} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
async function rejects(p) { try { await p; return null; } catch (e) { return e.message; } }

async function run() {
    const auth = require('../key-authorizer');
    console.log('\nAWS Lambda Aforo authorizer — client-credential JWT tests\n');

    console.log('Test J1: valid JWT → Allow, context from claims');
    const token = sign(claims({ agent_id: 'agent-7' }));
    const p = await auth.handler({ authorizationToken: `Bearer ${token}`, methodArn: ARN });
    assertEquals(p.policyDocument.Statement[0].Effect, 'Allow', 'Allow');
    assertEquals(p.policyDocument.Statement[0].Resource, 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*', 'stage wildcard');
    assertEquals(p.principalId, 'cust-1', 'principalId = customer_id');
    assertEquals(p.context.customerId, 'cust-1', 'context.customerId');
    assertEquals(p.context.keyId, 'key-9', 'context.keyId');
    assertEquals(p.context.subscriptionId, 'sub-1', 'single subscription → subscriptionId');
    assertEquals(p.context.subscriptionIds, 'sub-1', 'subscriptionIds');
    assertEquals(p.context.agentId, 'agent-7', 'agentId from agent_id claim');
    assertEquals(p.context.authType, 'jwt', 'authType jwt');
    assertEquals(p.context.productType, '', 'productType empty');
    assert(Object.values(p.context).every(v => typeof v === 'string'), 'context values are strings');
    assertEquals(fetchStub.calls, 1, 'JWKS fetched once');

    console.log('\nTest J2: cached by token hash; JWKS cached');
    await auth.handler({ authorizationToken: `Bearer ${token}`, methodArn: ARN });
    const t2 = sign(claims({ subscription_ids: ['s-a', 's-b'] }));
    const p2 = await auth.handler({ authorizationToken: t2, methodArn: ARN });
    assertEquals(fetchStub.calls, 1, 'no extra JWKS fetch');
    assertEquals(p2.context.subscriptionId, '', 'several subscriptions → no single subscriptionId');
    assertEquals(p2.context.subscriptionIds, 's-a,s-b', 'subscriptionIds comma-joined');
    assertEquals(p2.context.agentId, '', 'no agent_id → ""');

    console.log('\nTest J3: bad tokens → Unauthorized');
    const deny = async (t, msg) => assertEquals(await rejects(auth.handler({ authorizationToken: `Bearer ${t}`, methodArn: ARN })), 'Unauthorized', msg);
    await deny(sign(claims(), { key: other.privateKey }), 'signature from another key');
    const [h, pl] = sign(claims()).split('.');
    await deny(`${h}.${b64(claims({ customer_id: 'evil', sub: 'evil' }))}.${sign(claims()).split('.')[2]}`, 'tampered payload');
    await deny(`${b64({ alg: 'none', kid: 'aforo-v1' })}.${pl}.AAAA`, 'alg none');
    const hsH = b64({ alg: 'HS256', kid: 'aforo-v1' });
    const hs = crypto.createHmac('sha256', publicKey.export({ format: 'pem', type: 'spki' })).update(`${hsH}.${pl}`).digest('base64url');
    await deny(`${hsH}.${pl}.${hs}`, 'HS256 with the public key as secret (key confusion)');
    await deny(sign(claims({ exp: now() - 3600, iat: now() - 4000 })), 'expired');
    await deny(sign(claims({ exp: undefined })), 'no exp');
    await deny(sign(claims({ nbf: now() + 3600 })), 'not yet valid (nbf)');
    await deny(sign(claims({ iat: now() + 3600 })), 'iat in the future');
    await deny(sign(claims({ tenant_id: 'tenant-other' })), 'wrong tenant');
    await deny(sign(claims({ iss: 'https://evil.example' })), 'wrong issuer');
    await deny(sign(claims({ customer_id: undefined, sub: undefined })), 'no customer');
    auth._resetJwks({ keepKeys: true }); // pretend the last fetch was long ago
    const before = fetchStub.calls;
    await deny(sign(claims(), { kid: 'unknown-kid' }), 'unknown kid');
    assertEquals(fetchStub.calls, before + 1, 'unknown kid refetched JWKS once');
    await deny(sign(claims(), { kid: 'unknown-kid-2' }), 'second unknown kid');
    assertEquals(fetchStub.calls, before + 1, 'refetch rate-limited');

    console.log('\nTest J4: rotated key is picked up via refetch on unknown kid');
    auth._resetJwks();
    const rotated = { ...other.publicKey.export({ format: 'jwk' }), kid: 'aforo-v2', use: 'sig', alg: 'RS256' };
    fetchStub.keys = [jwk];
    await auth.handler({ authorizationToken: sign(claims()), methodArn: ARN }); // loads v1
    fetchStub.keys = [jwk, rotated];
    auth._resetJwks({ keepKeys: true }); // last refetch long ago; v1 still cached
    const okRot = await auth.handler({ authorizationToken: sign(claims(), { kid: 'aforo-v2', key: other.privateKey }), methodArn: ARN });
    assertEquals(okRot.policyDocument.Statement[0].Effect, 'Allow', 'token signed with rotated key accepted');
    fetchStub.keys = [jwk];

    console.log('\nTest J5: JWKS unavailable → fail closed (500-style), not cached');
    auth._resetJwks();
    auth._clearCache();
    fetchStub.fail = 1;
    const origErr = console.error;
    const logged = [];
    console.error = (...a) => logged.push(a.join(' '));
    const fresh = sign(claims());
    const e5 = await rejects(auth.handler({ authorizationToken: `Bearer ${fresh}`, methodArn: ARN }));
    console.error = origErr;
    assert(e5 !== null && e5 !== 'Unauthorized', 'JWKS failure denies with a non-401 error');
    const ok5 = await auth.handler({ authorizationToken: `Bearer ${fresh}`, methodArn: ARN });
    assertEquals(ok5.policyDocument.Statement[0].Effect, 'Allow', 'next call refetches and succeeds');
    assert(!logged.join('\n').includes(fresh.split('.')[1]), 'token never logged');

    console.log('\nTest J6: AFORO_TENANT_ID unset → every JWT refused');
    delete require.cache[require.resolve('../key-authorizer')];
    delete process.env.AFORO_TENANT_ID;
    const noTenant = require('../key-authorizer');
    process.env.AFORO_TENANT_ID = 'tenant-42';
    console.error = () => {};
    const e6 = await rejects(noTenant.handler({ authorizationToken: `Bearer ${sign(claims())}`, methodArn: ARN }));
    console.error = origErr;
    assertEquals(e6, 'Unauthorized', 'JWT refused without AFORO_TENANT_ID');

    console.log('\nTest J7: key path untouched by JWT config (no tenant key → config error for sk_ keys only)');
    delete require.cache[require.resolve('../key-authorizer')];
    delete process.env.AFORO_TENANT_KEY;
    const jwtOnly = require('../key-authorizer');
    console.error = () => {};
    const e7 = await rejects(jwtOnly.handler({ authorizationToken: `Bearer sk_live_${'a'.repeat(32)}`, methodArn: ARN }));
    console.error = origErr;
    assert(e7 !== null && e7 !== 'Unauthorized', 'sk_ key without AFORO_TENANT_KEY → configuration error (unchanged)');
    const p7 = await jwtOnly.handler({ authorizationToken: `Bearer ${sign(claims())}`, methodArn: ARN });
    assertEquals(p7.context.authType, 'jwt', 'JWT path works without AFORO_TENANT_KEY');
}

run().catch(err => { failed++; console.error('  FAIL: tests threw', err); })
    .finally(() => {
        console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
        process.exit(failed > 0 ? 1 : 0);
    });
