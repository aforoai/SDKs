'use strict';
/**
 * aws-secret.js — reads the Aforo key from AWS Secrets Manager (G337).
 *
 * Built-ins only (the one-click deploy zips no node_modules), so the module
 * signs GetSecretValue with SigV4 itself. These tests pin the signer to AWS's
 * published SigV4 example, then drive the client against a local server
 * standing in for Secrets Manager.
 */
const http = require('http');
const assert = require('assert');
const secret = require('../aws-secret');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS: ${name}`);
    } catch (err) {
        failed++;
        console.log(`  FAIL: ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : err}`);
    }
}

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const ARN = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:aforo/metering/api-key-AbCdEf';

function fakeSecretsManager(handler) {
    return new Promise((resolve) => {
        const requests = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                requests.push({ method: req.method, url: req.url, headers: req.headers, body });
                const r = handler(requests.length, JSON.parse(body || '{}'), req.headers);
                res.writeHead(r.status, { 'Content-Type': 'application/x-amz-json-1.1' });
                res.end(JSON.stringify(r.body));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
    });
}

function lambdaEnv(endpoint, extra = {}) {
    return {
        AWS_REGION: 'eu-west-1',
        AWS_ACCESS_KEY_ID: CREDS.accessKeyId,
        AWS_SECRET_ACCESS_KEY: CREDS.secretAccessKey,
        AWS_SESSION_TOKEN: 'session-token-example',
        AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint,
        ...extra,
    };
}

(async () => {
    console.log('\nSigV4 signer');

    await test('matches the AWS SigV4 documentation example (IAM ListUsers)', () => {
        const signed = secret.signV4({
            method: 'GET',
            host: 'iam.amazonaws.com',
            path: '/',
            query: 'Action=ListUsers&Version=2010-05-08',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
            body: '',
            region: 'us-east-1',
            service: 'iam',
            credentials: CREDS,
            amzDate: '20150830T123600Z',
        });
        assert.strictEqual(signed.authorization,
            'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
            'SignedHeaders=content-type;host;x-amz-date, ' +
            'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    });

    console.log('\nGetSecretValue');

    await test('POSTs a signed GetSecretValue for the configured ARN and returns SecretString', async () => {
        const fake = await fakeSecretsManager(() => ({ status: 200, body: { SecretString: 'sk_live_abc' } }));
        try {
            const value = await secret.getSecretValue(ARN, lambdaEnv(fake.url));
            assert.strictEqual(value, 'sk_live_abc');
            const r = fake.requests[0];
            assert.strictEqual(r.method, 'POST');
            assert.strictEqual(r.headers['x-amz-target'], 'secretsmanager.GetSecretValue');
            assert.strictEqual(r.headers['content-type'], 'application/x-amz-json-1.1');
            assert.strictEqual(r.headers['x-amz-security-token'], 'session-token-example');
            assert.match(r.headers.authorization,
                /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);
            assert.deepStrictEqual(JSON.parse(r.body), { SecretId: ARN });
        } finally { fake.server.close(); }
    });

    await test('region comes from the ARN, not AWS_REGION', () => {
        assert.strictEqual(secret.secretsManagerUrl(ARN, { AWS_REGION: 'us-east-1' }),
            'https://secretsmanager.eu-west-1.amazonaws.com/');
        assert.strictEqual(secret.secretsManagerUrl(
            'arn:aws-cn:secretsmanager:cn-north-1:123456789012:secret:k-AbCdEf', {}),
            'https://secretsmanager.cn-north-1.amazonaws.com.cn/');
        assert.strictEqual(secret.secretsManagerUrl('aforo/key', { AWS_REGION: 'us-west-2' }),
            'https://secretsmanager.us-west-2.amazonaws.com/');
    });

    await test('an AWS error is reported by type, never with the response body', async () => {
        const fake = await fakeSecretsManager(() => ({
            status: 400, body: { __type: 'AccessDeniedException', Message: 'not authorized' },
        }));
        try {
            await assert.rejects(secret.getSecretValue(ARN, lambdaEnv(fake.url)),
                /GetSecretValue failed: HTTP 400 AccessDeniedException/);
        } finally { fake.server.close(); }
    });

    await test('missing Lambda credentials fail before any request', async () => {
        await assert.rejects(secret.getSecretValue(ARN, { AWS_REGION: 'eu-west-1' }), /credentials/);
    });

    console.log('\nsecret value format');

    await test('plain text is trimmed; JSON is read from its apiKey field', () => {
        assert.strictEqual(secret.extractKey('  sk_live_abc\n'), 'sk_live_abc');
        assert.strictEqual(secret.extractKey('{"apiKey":"sk_live_json"}'), 'sk_live_json');
        assert.throws(() => secret.extractKey('{"key":"x"}'), /apiKey/);
        assert.throws(() => secret.extractKey('   '), /empty/);
    });

    console.log('\nsecret source (per-container cache)');

    await test('fetches once per container and reuses the value', async () => {
        let calls = 0;
        const src = secret.createSecretSource({
            label: 'test key', secretIdEnv: 'KEY_SECRET_ARN', plainEnv: 'KEY',
            env: { KEY_SECRET_ARN: ARN },
            fetchSecret: async (id) => { calls++; assert.strictEqual(id, ARN); return 'sk_live_once'; },
        });
        assert.strictEqual(await src.get(), 'sk_live_once');
        assert.strictEqual(await src.get(), 'sk_live_once');
        assert.strictEqual(calls, 1);
    });

    await test('concurrent cold-start callers share one fetch', async () => {
        let calls = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN },
            fetchSecret: () => { calls++; return new Promise((r) => setTimeout(() => r('k'), 20)); },
        });
        const values = await Promise.all([src.get(), src.get(), src.get()]);
        assert.deepStrictEqual(values, ['k', 'k', 'k']);
        assert.strictEqual(calls, 1);
    });

    await test('refetches after the refresh interval (rotation reaches warm containers)', async () => {
        let t = 0;
        let n = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, refreshMs: 1000, now: () => t,
            fetchSecret: async () => `k${++n}`,
        });
        assert.strictEqual(await src.get(), 'k1');
        t = 999;
        assert.strictEqual(await src.get(), 'k1');
        t = 1000;
        assert.strictEqual(await src.get(), 'k2');
    });

    await test('a failed first fetch throws and is retried once the backoff has passed', async () => {
        let t = 0;
        let n = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, now: () => t,
            fetchSecret: async () => { n++; if (n === 1) throw new Error('boom'); return 'k'; },
        });
        await assert.rejects(src.get(), /boom/);
        t = 5000;
        assert.strictEqual(await src.get(), 'k');
    });

    await test('no cached value: after a failure calls fail fast for up to 5 s instead of calling AWS', async () => {
        let t = 0;
        let n = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, now: () => t,
            fetchSecret: async () => { n++; throw new Error('AccessDeniedException'); },
        });
        await assert.rejects(src.get(), /AccessDeniedException/);
        await assert.rejects(src.get(), /AccessDeniedException/);
        t = 2000;
        await assert.rejects(src.get(), /AccessDeniedException/);
        assert.strictEqual(n, 1, 'one GetSecretValue call during the backoff (was one per invocation)');
    });

    await test('the backoff doubles up to 60 s, with jitter, and resets on success', async () => {
        let t = 0;
        let n = 0;
        let ok = false;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, now: () => t, random: () => 1,
            fetchSecret: async () => { n++; if (ok) return 'k'; throw new Error('down'); },
        });
        await assert.rejects(src.get(), /down/);
        assert.strictEqual(n, 1);
        const waits = [];
        for (let i = 0; i < 6; i++) {
            let w = 0;
            for (;;) { w += 500; t += 500; const b = n; await src.get().catch(() => {}); if (n > b) break; }
            waits.push(w);
        }
        // random() = 1 → full delay: 5, 10, 20, 40, 60, 60 s (the probe call fails, starting the next window).
        assert.deepStrictEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000]);
        ok = true;
        t += 60000;
        assert.strictEqual(await src.get(), 'k');
    });

    await test('jitter keeps the backoff between half and the full delay', async () => {
        let t = 0;
        let n = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, now: () => t, random: () => 0,
            fetchSecret: async () => { n++; throw new Error('down'); },
        });
        await assert.rejects(src.get(), /down/);
        t = 2499;
        await assert.rejects(src.get(), /down/);
        assert.strictEqual(n, 1);
        t = 2500;
        await assert.rejects(src.get(), /down/);
        assert.strictEqual(n, 2);
    });

    await test('a failed refresh keeps serving the last good value', async () => {
        let t = 0;
        let n = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, refreshMs: 10, now: () => t,
            fetchSecret: async () => { n++; if (n === 2) throw new Error('throttled'); return `k${n}`; },
        });
        assert.strictEqual(await src.get(), 'k1');
        t = 50;
        assert.strictEqual(await src.get(), 'k1');
    });

    await test('no secret configured: the plain environment variable still works (one-click deploys)', async () => {
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { P: 'plain-key' },
            fetchSecret: async () => { throw new Error('must not be called'); },
        });
        assert.strictEqual(await src.get(), 'plain-key');
        assert.strictEqual(src.configured, true);
    });

    await test('secret configured: it wins over the plain variable', async () => {
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN, P: 'plain-key' },
            fetchSecret: async () => 'from-secret',
        });
        assert.strictEqual(await src.get(), 'from-secret');
    });

    await test('nothing configured: empty, configured=false', async () => {
        const src = secret.createSecretSource({ label: 't', secretIdEnv: 'S', plainEnv: 'P', env: {} });
        assert.strictEqual(src.configured, false);
        assert.strictEqual(await src.get(), '');
    });

    await test('refresh() rereads at once, inside the refresh interval, and later get() uses the new key', async () => {
        let n = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, refreshMs: 300000, now: () => 0,
            fetchSecret: async () => `k${++n}`,
        });
        assert.strictEqual(await src.get(), 'k1');
        assert.strictEqual(await src.refresh(), 'k2');
        assert.strictEqual(await src.get(), 'k2');
        assert.strictEqual(n, 2);
    });

    await test('refresh(): concurrent callers share one fetch', async () => {
        let n = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, now: () => 0,
            fetchSecret: async () => { n++; await new Promise((r) => setTimeout(r, 5)); return 'k' + n; },
        });
        await src.get();
        const values = await Promise.all([src.refresh(), src.refresh(), src.refresh()]);
        assert.deepStrictEqual(values, ['k2', 'k2', 'k2']);
        assert.strictEqual(n, 2);
    });

    await test('refresh(): a failed reread throws (the refused cached key is not handed back)', async () => {
        let n = 0;
        const src = secret.createSecretSource({
            label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { S: ARN }, now: () => 0,
            fetchSecret: async () => { n++; if (n > 1) throw new Error('AccessDenied'); return 'k'; },
        });
        await src.get();
        await assert.rejects(src.refresh(), /could not reread S.*AccessDenied/);
    });

    await test('refresh() with the plain variable returns it', async () => {
        const src = secret.createSecretSource({ label: 't', secretIdEnv: 'S', plainEnv: 'P', env: { P: 'plain' } });
        assert.strictEqual(await src.refresh(), 'plain');
    });

    await test('getSecretValue: a response that dies after its headers rejects instead of crashing', async () => {
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"SecretString":');
            setTimeout(() => res.socket.destroy(), 10);
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        try {
            const env = { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_REGION: 'eu-west-1',
                AWS_ENDPOINT_URL_SECRETS_MANAGER: `http://127.0.0.1:${server.address().port}` };
            const hung = new Promise((r) => setTimeout(() => r('hung'), 3000).unref());
            const outcome = await Promise.race([
                secret.getSecretValue(ARN, env, 2000).then(() => 'resolved', (e) => 'rejected: ' + e.message),
                hung,
            ]);
            assert.ok(/^rejected/.test(outcome), outcome);
        } finally {
            server.close();
        }
    });

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    process.exit(failed > 0 ? 1 : 0);
})();
