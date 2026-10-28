'use strict';
/**
 * G337 / G338 wiring: index.js and key-authorizer.js read their Aforo key
 * from Secrets Manager when *_SECRET_ARN is set, and FLUSH_COUNT defaults to
 * 500. Runs against two local servers: a stand-in for Secrets Manager and one
 * for the Aforo ingestor / introspection endpoint.
 */
const http = require('http');
const zlib = require('zlib');

let passed = 0;
let failed = 0;
function assert(condition, msg) {
    if (condition) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); }
}
function assertEquals(actual, expected, msg) {
    assert(actual === expected, actual === expected ? msg
        : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => handler(req, body, res));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}
const url = (server, p = '') => `http://127.0.0.1:${server.address().port}${p}`;

function cwEvent(entries) {
    const logData = {
        messageType: 'DATA_MESSAGE',
        logGroup: '/aws/apigateway/test',
        logEvents: entries.map((e, i) => ({ id: 'ev' + i, timestamp: 1767225600000 + i, message: JSON.stringify(e) })),
    };
    return { awslogs: { data: zlib.gzipSync(Buffer.from(JSON.stringify(logData))).toString('base64') } };
}
const ctx = { getRemainingTimeInMillis: () => 20000 };
const ENTRY = (id) => ({ requestId: id, httpMethod: 'GET', resourcePath: '/a', status: '200', customerId: 'cust_1' });

function freshRequire(mod) {
    delete require.cache[require.resolve(mod)];
    delete require.cache[require.resolve('../aws-secret')];
    return require(mod);
}

function clearAforoEnv() {
    for (const k of ['AFORO_API_KEY', 'AFORO_API_KEY_SECRET_ARN', 'AFORO_TENANT_KEY', 'AFORO_TENANT_KEY_SECRET_ARN',
        'FLUSH_COUNT']) delete process.env[k];
}

const SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:aforo/metering/api-key-AbCdEf';

async function run() {
    let smMode = 'ok';
    const smCalls = [];
    const sm = await listen((req, body, res) => {
        smCalls.push({ target: req.headers['x-amz-target'], body: JSON.parse(body) });
        if (smMode === 'fail') { res.writeHead(400); return res.end(JSON.stringify({ __type: 'AccessDeniedException' })); }
        res.writeHead(200);
        res.end(JSON.stringify({ SecretString: smMode === 'json' ? '{"apiKey":"sk_live_from_json"}'
            : smMode === 'rotated' ? 'sk_live_rotated' : 'sk_live_from_secret' }));
    });
    const posts = [];
    let acceptedKeys = null; // null: accept any key
    const ingest = await listen((req, body, res) => {
        posts.push({ headers: req.headers, body: JSON.parse(body) });
        if (acceptedKeys && !acceptedKeys.includes(req.headers['x-api-key'])) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end('{"success":false,"error":{"code":"UNAUTHORIZED"}}');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { results: [] } }));
    });

    Object.assign(process.env, {
        AWS_REGION: 'eu-west-1',
        AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        AWS_SESSION_TOKEN: 'token',
        AWS_ENDPOINT_URL_SECRETS_MANAGER: url(sm),
        AFORO_ENDPOINT: url(ingest, '/v1/ingest/batch'),
    });

    console.log('\nG338: FLUSH_COUNT');
    clearAforoEnv();
    assertEquals(freshRequire('../index').FLUSH_COUNT, 500, 'default batch size is 500');
    process.env.FLUSH_COUNT = '250';
    assertEquals(freshRequire('../index').FLUSH_COUNT, 250, 'FLUSH_COUNT=250 honoured');

    console.log('\nG337: index.js reads AFORO_API_KEY_SECRET_ARN');
    clearAforoEnv();
    process.env.AFORO_API_KEY_SECRET_ARN = SECRET_ARN;
    let { handler } = freshRequire('../index');
    await handler(cwEvent([ENTRY('r1')]), ctx);
    await handler(cwEvent([ENTRY('r2')]), ctx);
    assertEquals(posts.length, 2, 'two invocations, two POSTs');
    assertEquals(posts[0].headers['x-api-key'], 'sk_live_from_secret', 'X-API-Key is the secret value');
    assertEquals(posts[1].headers['x-api-key'], 'sk_live_from_secret', 'second invocation reuses it');
    assertEquals(smCalls.length, 1, 'Secrets Manager read once per container');
    assertEquals(smCalls[0].target, 'secretsmanager.GetSecretValue', 'GetSecretValue called');
    assertEquals(smCalls[0].body.SecretId, SECRET_ARN, 'for the configured ARN');

    console.log('\nG337: a JSON secret with an apiKey field');
    smMode = 'json'; posts.length = 0;
    ({ handler } = freshRequire('../index'));
    await handler(cwEvent([ENTRY('r3')]), ctx);
    assertEquals(posts[0] && posts[0].headers['x-api-key'], 'sk_live_from_json', 'apiKey field used');

    console.log('\nG337: Secrets Manager unreachable → invocation fails, nothing dropped');
    smMode = 'fail'; posts.length = 0;
    ({ handler } = freshRequire('../index'));
    let threw = null;
    try { await handler(cwEvent([ENTRY('r4')]), ctx); } catch (e) { threw = e.message; }
    assert(threw !== null, 'handler throws so Lambda retries the invocation');
    assert(threw && /AccessDeniedException/.test(threw), 'error names the AWS error');
    assertEquals(posts.length, 0, 'no POST without a key');

    console.log('\nG337: no key configured at all → invocation fails rather than posting without a key');
    clearAforoEnv(); posts.length = 0;
    ({ handler } = freshRequire('../index'));
    threw = null;
    try { await handler(cwEvent([ENTRY('r5')]), ctx); } catch (e) { threw = e.message; }
    assert(threw && /not configured/.test(threw), 'clear error');
    assertEquals(posts.length, 0, 'nothing sent');

    console.log('\nG337: the plain AFORO_API_KEY still works (one-click deploy path)');
    clearAforoEnv(); posts.length = 0;
    process.env.AFORO_API_KEY = 'plain-key';
    ({ handler } = freshRequire('../index'));
    await handler(cwEvent([ENTRY('r6')]), ctx);
    assertEquals(posts[0] && posts[0].headers['x-api-key'], 'plain-key', 'plain key sent');

    console.log('\nKey rotation: a 401 rereads the secret once and resends; still refused, the invocation fails');
    clearAforoEnv(); posts.length = 0; smCalls.length = 0; smMode = 'ok'; acceptedKeys = null;
    process.env.AFORO_API_KEY_SECRET_ARN = SECRET_ARN;
    ({ handler } = freshRequire('../index'));
    await handler(cwEvent([ENTRY('rot1')]), ctx);
    assertEquals(posts.length, 1, 'first invocation sent with the cached key');
    smMode = 'rotated'; acceptedKeys = ['sk_live_rotated']; posts.length = 0;
    let rot = null;
    try { rot = await handler(cwEvent([ENTRY('rot2'), ENTRY('rot3')]), ctx); } catch (e) { rot = e; }
    assert(!(rot instanceof Error), 'rotated key: the invocation succeeds after the reread (' + (rot && rot.message) + ')');
    assertEquals(posts.length, 2, 'one refused POST, one resend');
    assertEquals(posts[0].headers['x-api-key'], 'sk_live_from_secret', 'first try with the cached key');
    assertEquals(posts[1].headers['x-api-key'], 'sk_live_rotated', 'resend with the reread key');
    assertEquals(JSON.stringify(posts[1].body), JSON.stringify(posts[0].body), 'resend carries the same body (same idempotency keys)');
    assertEquals(smCalls.length, 2, 'the secret was read again once');

    acceptedKeys = ['someone-else']; posts.length = 0;
    let refused = null;
    try { await handler(cwEvent([ENTRY('rot4')]), ctx); } catch (e) { refused = e.message; }
    assert(refused !== null && /transient/.test(refused), '401 with the current key: the handler throws so Lambda redelivers');
    assertEquals(posts.length, 1, 'no resend when the secret holds the same key');

    smMode = 'fail'; posts.length = 0;
    ({ handler } = freshRequire('../index'));
    smMode = 'ok';
    acceptedKeys = ['sk_live_rotated'];
    await handler(cwEvent([ENTRY('rot5')]), ctx).catch(() => {});
    smMode = 'fail'; posts.length = 0;
    let readFail = null;
    try { await handler(cwEvent([ENTRY('rot6')]), ctx); } catch (e) { readFail = e.message; }
    assert(readFail !== null, '401 and the secret cannot be reread: the handler throws');

    console.log('\nA key that stays refused rereads the secret at most once a minute per container');
    clearAforoEnv(); posts.length = 0; smCalls.length = 0; smMode = 'ok'; acceptedKeys = ['someone-else'];
    process.env.AFORO_API_KEY_SECRET_ARN = SECRET_ARN;
    const realNow = Date.now;
    let clock = 1800000000000;
    Date.now = () => clock;
    try {
        const idx = freshRequire('../index');
        assertEquals(idx.FORCED_KEY_REFRESH_MIN_MS, 60000, 'the minimum interval is 60 s');
        let errs = 0;
        for (let n = 0; n < 5; n++) {
            clock += 1000;
            try { await idx.handler(cwEvent([ENTRY('stuck' + n)]), ctx); } catch (e) { errs++; }
        }
        assertEquals(errs, 5, 'every refused invocation throws (events kept for redelivery)');
        assertEquals(posts.length, 5, 'one POST per invocation, no resend with the same key');
        assertEquals(smCalls.length, 2, 'one cold read plus one forced reread, not one per invocation');
        clock += 60000;
        try { await idx.handler(cwEvent([ENTRY('stuck-later')]), ctx); } catch (e) { errs++; }
        assertEquals(smCalls.length, 3, 'a minute later the secret is reread once more');
        smMode = 'rotated'; acceptedKeys = ['sk_live_rotated']; posts.length = 0;
        clock += 61000;
        let ok = null;
        try { ok = await idx.handler(cwEvent([ENTRY('after')]), ctx); } catch (e) { ok = e; }
        assert(!(ok instanceof Error), 'after the interval a rotated key is picked up and the resend succeeds');
        assertEquals(posts.length, 2, 'refused POST, then the resend with the new key');
    } finally {
        Date.now = realNow;
    }

    clearAforoEnv(); posts.length = 0; acceptedKeys = ['other'];
    process.env.AFORO_API_KEY = 'plain-key';
    ({ handler } = freshRequire('../index'));
    let plainRefused = null;
    try { await handler(cwEvent([ENTRY('rot7')]), ctx); } catch (e) { plainRefused = e.message; }
    assert(plainRefused !== null, 'plain key refused: the handler throws instead of returning 200');
    assertEquals(posts.length, 1, 'plain key: nothing to reread, one POST');
    acceptedKeys = null;

    console.log('\nG337: key-authorizer.js reads AFORO_TENANT_KEY_SECRET_ARN');
    const introspections = [];
    const intro = await listen((req, body, res) => {
        introspections.push(req.headers['x-api-key']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: true, keyId: 'k', customerId: 'cust_1', subscriptionId: 's', productType: 'API' }));
    });
    clearAforoEnv(); smMode = 'ok'; smCalls.length = 0;
    process.env.AFORO_INTROSPECT_URL = url(intro, '/api/v1/customer-keys/introspect');
    process.env.AFORO_TENANT_KEY_SECRET_ARN = SECRET_ARN;
    const auth = freshRequire('../key-authorizer');
    const methodArn = 'arn:aws:execute-api:us-east-1:123456789012:abc/prod/GET/a';
    const policy = await auth.handler({ authorizationToken: 'Bearer sk_live_' + 'a'.repeat(32), methodArn });
    assertEquals(policy.policyDocument.Statement[0].Effect, 'Allow', 'customer key allowed');
    assertEquals(introspections[0], 'sk_live_from_secret', 'introspection uses the tenant key from the secret');
    assertEquals(smCalls.length, 1, 'tenant key read from Secrets Manager');

    smMode = 'fail';
    const authDown = freshRequire('../key-authorizer');
    let authErr = null;
    try { await authDown.handler({ authorizationToken: 'Bearer sk_live_' + 'b'.repeat(32), methodArn }); } catch (e) { authErr = e.message; }
    assertEquals(authErr, 'Aforo key check unavailable', 'secret unavailable → fails closed (500), not Unauthorized');

    for (const s of [sm, ingest, intro]) s.close();
    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
