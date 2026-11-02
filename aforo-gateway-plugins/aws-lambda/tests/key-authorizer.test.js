/**
 * Tests for key-authorizer.js against a local stand-in for Aforo's
 * POST /api/v1/customer-keys/introspect.
 * Run with: node tests/key-authorizer.test.js  (npm test runs it).
 */

const http = require('http');

process.env.AFORO_TENANT_KEY = 'sk_live_tenant_test_key';
process.env.CACHE_TTL_MS = '60000';

const VALID = 'sk_live_' + 'a'.repeat(32);
const INACTIVE = 'sk_live_' + 'b'.repeat(32);
const FLAKY = 'sk_live_' + 'c'.repeat(32);
const NO_CUSTOMER = 'sk_live_' + 'd'.repeat(32);
const ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/POST/v1/sms/send';

const calls = [];
let flakyFailures = 1;
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        const { key } = JSON.parse(body);
        calls.push({ headers: req.headers, key });
        if (key === FLAKY && flakyFailures-- > 0) {
            res.writeHead(503); return res.end();
        }
        const answer = key === VALID || key === FLAKY
            ? { active: true, keyId: 'key_1', customerId: 'cust_1', subscriptionId: 'sub_1',
                subscriptionIds: ['sub_1'], productType: 'API', scopes: ['usage:write'] }
            : key === NO_CUSTOMER ? { active: true } : { active: false };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
    });
});

let passed = 0;
let failed = 0;
function assert(condition, msg) {
    if (condition) { passed++; console.log('  PASS: ' + msg); }
    else { failed++; console.error('  FAIL: ' + msg); }
}
function assertEquals(actual, expected, msg) {
    assert(actual === expected, actual === expected ? msg
        : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function rejects(promise) {
    try { await promise; return null; } catch (e) { return e.message; }
}

async function run() {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.AFORO_INTROSPECT_URL = `http://127.0.0.1:${server.address().port}/api/v1/customer-keys/introspect`;
    const auth = require('../key-authorizer');

    console.log('\nAWS Lambda Aforo customer-key authorizer — Tests\n');

    console.log('Test 1: key extraction');
    assertEquals(auth.extractKey(`Bearer ${VALID}`), VALID, 'Bearer prefix stripped');
    assertEquals(auth.extractKey(VALID), VALID, 'bare key accepted');
    assertEquals(auth.extractKey('Bearer sk_live_short'), null, 'wrong length rejected');
    assertEquals(auth.extractKey('Bearer eyJhbGciOi.jwt.token'), null, 'JWT is not a customer key');
    assertEquals(auth.extractKey(undefined), null, 'missing header rejected');

    console.log('\nTest 2: active key → Allow for the whole stage, identity in context');
    calls.length = 0;
    const p = await auth.handler({ authorizationToken: `Bearer ${VALID}`, methodArn: ARN });
    assertEquals(p.principalId, 'cust_1', 'principalId is the customer');
    assertEquals(p.policyDocument.Statement[0].Effect, 'Allow', 'Allow');
    assertEquals(p.policyDocument.Statement[0].Resource,
        'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*', 'resource wildcarded to the stage');
    assertEquals(p.context.customerId, 'cust_1', 'context.customerId');
    assertEquals(p.context.keyId, 'key_1', 'context.keyId');
    assertEquals(p.context.subscriptionId, 'sub_1', 'context.subscriptionId');
    assert(Object.values(p.context).every(v => typeof v === 'string'), 'context values are strings');
    assertEquals(calls.length, 1, 'one introspection call');
    assertEquals(calls[0].headers['x-api-key'], 'sk_live_tenant_test_key', 'tenant key sent as X-API-Key');
    assertEquals(calls[0].key, VALID, 'customer key sent in the body');

    console.log('\nTest 3: answers are cached per container');
    await auth.handler({ authorizationToken: `Bearer ${VALID}`, methodArn: ARN });
    assertEquals(calls.length, 1, 'second call within TTL does not re-introspect');

    console.log('\nTest 4: inactive, malformed and customer-less keys → Unauthorized (401)');
    assertEquals(await rejects(auth.handler({ authorizationToken: `Bearer ${INACTIVE}`, methodArn: ARN })),
        'Unauthorized', 'inactive key');
    const before = calls.length;
    assertEquals(await rejects(auth.handler({ authorizationToken: 'Bearer nope', methodArn: ARN })),
        'Unauthorized', 'malformed key');
    assertEquals(calls.length, before, 'malformed key never reaches Aforo');
    assertEquals(await rejects(auth.handler({ authorizationToken: `Bearer ${NO_CUSTOMER}`, methodArn: ARN })),
        'Unauthorized', 'active answer without customerId');

    console.log('\nTest 5: Aforo unavailable → fails closed, not cached');
    const err = await rejects(auth.handler({ authorizationToken: `Bearer ${FLAKY}`, methodArn: ARN }));
    assert(err !== null && err !== 'Unauthorized', 'introspection failure denies with a non-401 error');
    const ok = await auth.handler({ authorizationToken: `Bearer ${FLAKY}`, methodArn: ARN });
    assertEquals(ok.policyDocument.Statement[0].Effect, 'Allow', 'next call re-introspects and succeeds');

    console.log('\nTest 6: customer key never written to logs');
    const logged = [];
    const origLog = console.log, origErr = console.error;
    console.log = (...a) => logged.push(a.join(' '));
    console.error = (...a) => logged.push(a.join(' '));
    try {
        auth._clearCache();
        flakyFailures = 1;
        await rejects(auth.handler({ authorizationToken: `Bearer ${FLAKY}`, methodArn: ARN }));
        await auth.handler({ authorizationToken: `Bearer ${VALID}`, methodArn: ARN });
    } finally {
        console.log = origLog; console.error = origErr;
    }
    assert(!logged.join('\n').includes('sk_live_'), 'no key material in logs');

    console.log('\nTest 7: no tenant key configured → every call denied');
    delete require.cache[require.resolve('../key-authorizer')];
    const savedKey = process.env.AFORO_TENANT_KEY;
    delete process.env.AFORO_TENANT_KEY;
    const unconfigured = require('../key-authorizer');
    process.env.AFORO_TENANT_KEY = savedKey;
    const origError = console.error;
    console.error = () => {};
    const e7 = await rejects(unconfigured.handler({ authorizationToken: `Bearer ${VALID}`, methodArn: ARN }));
    console.error = origError;
    assert(e7 !== null && e7 !== 'Unauthorized', 'denied with a configuration error');
}

run().catch(err => { failed++; console.error('  FAIL: tests threw', err); })
    .finally(() => {
        server.close();
        console.log('\n── Results: ' + passed + ' passed, ' + failed + ' failed ──\n');
        process.exit(failed > 0 ? 1 : 0);
    });
