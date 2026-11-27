/**
 * key-authorizer.js 2.7.0 (G341): per-method Allow by default,
 * AFORO_POLICY_RESOURCE, AFORO_ROUTE_SCOPES for customer keys and JWTs, and
 * REQUEST authorizer events.
 * Run with: node tests/key-authorizer-scopes.test.js  (npm test runs it).
 *
 * A local stand-in answers the introspection call; an RSA key pair is served
 * as a JWKS through a stubbed global fetch. Nothing leaves the process.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

process.env.AFORO_TENANT_KEY = 'sk_live_tenant_test_key';
process.env.AFORO_TENANT_ID = 'tenant-42';
process.env.AFORO_JWKS_URL = 'https://jwks.test/.well-known/jwks.json';
process.env.CACHE_TTL_MS = '60000';
delete process.env.AFORO_ROUTE_SCOPES;
delete process.env.AFORO_POLICY_RESOURCE;

const STAGE = 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod';
const arn = (method, path) => `${STAGE}/${method}${path}`;
const READER = 'sk_live_' + 'a'.repeat(32);   // scopes: items:read
const WRITER = 'sk_live_' + 'b'.repeat(32);   // scopes: items:read items:write
const NOSCOPE = 'sk_live_' + 'c'.repeat(32);  // no scopes field

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const { key } = JSON.parse(body);
        const base = { active: true, keyId: 'key_1', customerId: 'cust_1', subscriptionId: 'sub_1', productType: 'API' };
        const answer = key === READER ? { ...base, scopes: ['items:read'] }
            : key === WRITER ? { ...base, scopes: ['items:read', 'items:write'] }
                : key === NOSCOPE ? base : { active: false };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
    });
});

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'aforo-v1', use: 'sig', alg: 'RS256' };
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ keys: [jwk] }) });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(scopes) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'RS256', kid: 'aforo-v1', typ: 'JWT' });
    const p = b64({
        sub: 'cust-1', iss: 'https://auth.aforo.ai', iat: now, exp: now + 900, jti: crypto.randomUUID(),
        tenant_id: 'tenant-42', customer_id: 'cust-1', key_id: 'key-9', subscription_ids: ['sub-1'], scopes,
    });
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    return `${h}.${p}.${s}`;
}

let passed = 0;
let failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); } }
function assertEquals(a, e, msg) {
    assert(a === e, a === e ? msg : `${msg} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
async function rejects(p) { try { await p; return null; } catch (e) { return e.message; } }
const effect = (p) => p.policyDocument.Statement[0].Effect;
const resource = (p) => p.policyDocument.Statement[0].Resource;

async function run() {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.AFORO_INTROSPECT_URL = `http://127.0.0.1:${server.address().port}/api/v1/customer-keys/introspect`;
    const auth = require('../key-authorizer');
    const routeScopes = require('../route-scopes');
    const setMap = (map) => {
        routeScopes._reset();
        if (map === undefined) delete process.env.AFORO_ROUTE_SCOPES;
        else process.env.AFORO_ROUTE_SCOPES = typeof map === 'string' ? map : JSON.stringify(map);
    };
    const call = (token, methodArn) => auth.handler({ authorizationToken: `Bearer ${token}`, methodArn });
    const quiet = async (fn) => {
        const w = console.warn; const e = console.error;
        console.warn = () => {}; console.error = () => {};
        try { return await fn(); } finally { console.warn = w; console.error = e; }
    };

    console.log('\nkey-authorizer 2.7.0 — route scopes and policy resource\n');

    console.log('Default: the Allow names the called method (no map)');
    setMap(undefined);
    let p = await call(READER, arn('GET', '/v1/items'));
    assertEquals(effect(p), 'Allow', 'customer key → Allow');
    assertEquals(resource(p), arn('GET', '/v1/items'), 'customer key: Allow covers the called method only');
    assertEquals(p.context.scopes, 'items:read', 'context.scopes from the introspection answer');
    p = await call(jwt('items:read'), arn('POST', '/mcp'));
    assertEquals(resource(p), arn('POST', '/mcp'), 'JWT: Allow covers the called method only');
    assertEquals(p.context.scopes, 'items:read', 'context.scopes from the JWT claim');
    p = await call(NOSCOPE, arn('DELETE', '/v1/items/7'));
    assertEquals(effect(p), 'Allow', 'no map: a key without scopes is still allowed');
    assertEquals(p.context.scopes, '', 'no scopes → empty context.scopes');

    console.log('\nAFORO_POLICY_RESOURCE=stage keeps the pre-2.7.0 stage-wide Allow');
    process.env.AFORO_POLICY_RESOURCE = 'stage';
    routeScopes._reset();
    p = await quiet(() => call(READER, arn('GET', '/v1/items')));
    assertEquals(resource(p), `${STAGE}/*`, 'customer key: stage-wide Allow');
    p = await quiet(() => call(jwt('items:read'), arn('POST', '/mcp')));
    assertEquals(resource(p), `${STAGE}/*`, 'JWT: stage-wide Allow');
    process.env.AFORO_POLICY_RESOURCE = 'anything-else';
    p = await call(READER, arn('GET', '/v1/items'));
    assertEquals(resource(p), arn('GET', '/v1/items'), 'an unknown value is read as "method"');
    delete process.env.AFORO_POLICY_RESOURCE;

    console.log('\nAFORO_ROUTE_SCOPES: customer keys');
    setMap({ 'GET /v1/items': 'items:read', 'DELETE /v1/items/{id}': ['items:write'], '*': 'items:read' });
    p = await call(READER, arn('GET', '/v1/items'));
    assertEquals(effect(p), 'Allow', 'key holding the route scope → Allow');
    assertEquals(resource(p), arn('GET', '/v1/items'), 'Allow names the method');
    p = await quiet(() => call(READER, arn('DELETE', '/v1/items/7')));
    assertEquals(effect(p), 'Deny', 'key without items:write → Deny on DELETE');
    assertEquals(p.context.error, 'INSUFFICIENT_SCOPE', 'Deny says INSUFFICIENT_SCOPE');
    assertEquals(resource(p), arn('DELETE', '/v1/items/7'), 'Deny covers the called method only');
    p = await call(WRITER, arn('DELETE', '/v1/items/7'));
    assertEquals(effect(p), 'Allow', 'key with items:write → Allow on DELETE');
    p = await quiet(() => call(NOSCOPE, arn('GET', '/v1/other')));
    assertEquals(effect(p), 'Deny', 'the "*" default applies to unmapped routes; a key with no scopes is denied');
    p = await quiet(() => call(READER, 'not-an-arn'));
    assertEquals(p.context.error, 'ROUTE_UNKNOWN', 'an unreadable method ARN → Deny ROUTE_UNKNOWN');

    console.log('\nAFORO_ROUTE_SCOPES: JWTs');
    p = await call(jwt('items:read items:write'), arn('DELETE', '/v1/items/7'));
    assertEquals(effect(p), 'Allow', 'JWT with items:write (space-separated claim) → Allow');
    p = await call(jwt(['items:read', 'items:write']), arn('DELETE', '/v1/items/9'));
    assertEquals(effect(p), 'Allow', 'JWT with an array scopes claim → Allow');
    p = await quiet(() => call(jwt('items:read'), arn('DELETE', '/v1/items/7')));
    assertEquals(p.context.error, 'INSUFFICIENT_SCOPE', 'JWT without items:write → Deny INSUFFICIENT_SCOPE');

    console.log('\nA map overrides AFORO_POLICY_RESOURCE=stage');
    process.env.AFORO_POLICY_RESOURCE = 'stage';
    p = await call(READER, arn('GET', '/v1/items'));
    assertEquals(resource(p), arn('GET', '/v1/items'), 'with a map the Allow still names the method');
    delete process.env.AFORO_POLICY_RESOURCE;

    console.log('\nA map that is not valid fails every call (500, never Allow)');
    setMap('{"GET /v1/items": ');
    const e1 = await quiet(() => rejects(call(WRITER, arn('GET', '/v1/items'))));
    assert(e1 !== null && e1 !== 'Unauthorized', 'customer key: configuration error, not Allow');
    const e2 = await quiet(() => rejects(call(jwt('items:read'), arn('GET', '/v1/items'))));
    assert(e2 !== null && e2 !== 'Unauthorized', 'JWT: configuration error, not Allow');

    console.log('\nREQUEST authorizer events (token in the Authorization header)');
    setMap({ 'GET /v1/items': 'items:read' });
    p = await auth.handler({ type: 'REQUEST', methodArn: arn('GET', '/v1/items'), headers: { authorization: `Bearer ${READER}` } });
    assertEquals(effect(p), 'Allow', 'REQUEST event with a customer key → Allow');
    p = await auth.handler({ type: 'REQUEST', methodArn: arn('GET', '/v1/items'), headers: { Authorization: `Bearer ${jwt('items:read')}` } });
    assertEquals(effect(p), 'Allow', 'REQUEST event with a JWT → Allow');
    const e3 = await rejects(auth.handler({ type: 'REQUEST', methodArn: arn('GET', '/v1/items'), headers: {} }));
    assertEquals(e3, 'Unauthorized', 'REQUEST event without Authorization → 401');
    setMap(undefined);
}

run().catch((err) => { failed++; console.error('  FAIL: tests threw', err); })
    .finally(() => {
        server.close();
        console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
        process.exit(failed > 0 ? 1 : 0);
    });
