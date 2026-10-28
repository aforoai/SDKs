/**
 * Tests for authorizer.js (JWT TOKEN authorizer): revocation over Redis
 * fails closed (G340), the Allow policy covers one stage (G341), and an
 * unknown kid refetches the JWKS at most once per 30 s (G343).
 * Run with: node tests/authorizer.test.js
 *
 * The JWKS is served by a local HTTP server and Redis is a local TCP (or,
 * when openssl is available, TLS) server speaking RESP. Nothing leaves the host.
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0;
let failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); } }
function assertEquals(a, e, msg) {
    assert(a === e, a === e ? msg : `${msg} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/v1/items';
const ISS = 'https://auth.aforo.ai';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, kid = 'k1') {
    const h = b64({ alg: 'RS256', kid, typ: 'JWT' });
    const p = b64(claims);
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    return `${h}.${p}.${s}`;
}
const now = () => Math.floor(Date.now() / 1000);
const token = (over = {}) => sign({
    sub: 'cust-1', customer_id: 'cust-1', tenant_id: 't1', key_id: 'key-9', jti: crypto.randomUUID(),
    iss: ISS, exp: now() + 900, ...over,
}, over.__kid || 'k1');

// ── JWKS server ──
const jwks = { hits: 0, fail: false };
const jwksServer = http.createServer((req, res) => {
    jwks.hits++;
    if (jwks.fail) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
});

// ── RESP server: reply(commands[]) returns the raw reply bytes ──
function parseCommands(buf) {
    const cmds = [];
    let s = buf.toString('utf8');
    while (s.startsWith('*')) {
        const lines = s.split('\r\n');
        const n = parseInt(lines[0].slice(1), 10);
        const args = [];
        let idx = 1;
        for (let i = 0; i < n; i++) { args.push(lines[idx + 1]); idx += 2; }
        cmds.push(args);
        s = lines.slice(idx).join('\r\n');
    }
    return cmds;
}
function respHandler(state) {
    return (sock) => {
        let data = Buffer.alloc(0);
        sock.on('data', (c) => {
            data = Buffer.concat([data, c]);
            const cmds = parseCommands(data);
            if (cmds.length === 0) return;
            state.received.push(...cmds);
            if (state.silent) return;
            const out = state.reply(cmds);
            if (state.split) {
                const mid = Math.floor(out.length / 2);
                sock.write(out.slice(0, mid));
                setTimeout(() => sock.write(out.slice(mid)), 10);
            } else {
                sock.write(out);
            }
            data = Buffer.alloc(0);
        });
        sock.on('error', () => {});
    };
}
const redis = { received: [], reply: () => '', silent: false, split: false };
const redisServer = net.createServer(respHandler(redis));

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function run() {
    const jwksPort = await listen(jwksServer);
    const redisPort = await listen(redisServer);
    process.env.AFORO_JWKS_URI = `http://127.0.0.1:${jwksPort}/jwks`;
    process.env.AFORO_JWT_ISSUER = ISS;
    process.env.AFORO_TENANT_ID = 't1';
    const auth = require('../authorizer');
    const T = auth._test;
    const call = (tok) => auth.handler({ authorizationToken: `Bearer ${tok}`, methodArn: METHOD_ARN });
    const effect = (p) => p.policyDocument.Statement[0].Effect;
    const resource = (p) => p.policyDocument.Statement[0].Resource;

    function useRedis(over = {}) {
        T.reset();
        delete process.env.REDIS_AUTH_TOKEN;
        delete process.env.REDIS_USERNAME;
        process.env.REDIS_HOST = '127.0.0.1';
        process.env.REDIS_PORT = String(over.port || redisPort);
        process.env.REDIS_TLS = over.tls || 'false';
        process.env.REDIS_TIMEOUT_MS = '300';
        delete process.env.REDIS_TLS_CA_FILE;
        if (over.auth) process.env.REDIS_AUTH_TOKEN = over.auth;
        redis.received = []; redis.silent = false; redis.split = false;
    }

    console.log('\nG340: revocation over Redis fails closed');
    useRedis();
    redis.reply = (cmds) => cmds.map(() => '$-1\r\n').join('');
    let p = await call(token());
    assertEquals(effect(p), 'Allow', 'nil replies (not revoked) → Allow');
    assertEquals(redis.received.length, 2, 'one GET per key on one connection');
    assert(redis.received[0][1].startsWith('jti:blocked:') && redis.received[1][1] === 'jti:client:key-9', 'blocklist keys');

    useRedis();
    redis.reply = (cmds) => cmds.map(() => '-NOAUTH Authentication required.\r\n').join('');
    p = await call(token());
    assertEquals(effect(p), 'Deny', '-NOAUTH reply → Deny (was read as "not revoked")');
    assertEquals(p.context.error, 'REVOCATION_CHECK_FAILED', 'Deny says why');

    useRedis();
    redis.reply = (cmds) => cmds.map(() => '*0\r\n').join('');
    p = await call(token());
    assertEquals(effect(p), 'Deny', 'unexpected reply type → Deny');

    useRedis();
    redis.reply = (cmds) => cmds.map(() => ':1\r\n').join('');
    p = await call(token());
    assertEquals(effect(p), 'Deny', 'integer reply to GET → Deny');

    useRedis();
    redis.reply = () => '$1\r\n1\r\n$-1\r\n';
    p = await call(token());
    assertEquals(p.context.error, 'TOKEN_REVOKED', 'blocklisted jti → Deny TOKEN_REVOKED');

    useRedis();
    redis.reply = () => '$-1\r\n$4\r\n2026\r\n';
    redis.split = true;
    p = await call(token());
    assertEquals(p.context.error, 'CLIENT_REVOKED', 'client revocation read across split TCP chunks');

    useRedis();
    redis.silent = true;
    p = await call(token());
    assertEquals(effect(p), 'Deny', 'Redis silent past REDIS_TIMEOUT_MS → Deny (was Allow)');

    const closed = net.createServer(); const closedPort = await listen(closed); await new Promise((r) => closed.close(r));
    useRedis({ port: closedPort });
    p = await call(token());
    assertEquals(effect(p), 'Deny', 'connection refused → Deny (was Allow)');

    useRedis({ auth: 's3cret' });
    redis.reply = (cmds) => cmds.map((c) => (c[0] === 'AUTH' ? (c[1] === 's3cret' ? '+OK\r\n' : '-WRONGPASS invalid\r\n') : '$-1\r\n')).join('');
    p = await call(token());
    assertEquals(effect(p), 'Allow', 'AUTH token sent before the GETs → Allow');
    assertEquals(redis.received[0][0], 'AUTH', 'first command is AUTH');
    assertEquals(redis.received.length, 3, 'AUTH + 2 GETs on one connection');

    useRedis({ auth: 'wrong' });
    p = await call(token());
    assertEquals(effect(p), 'Deny', '-WRONGPASS → Deny');

    useRedis({ auth: 'pw' });
    process.env.REDIS_USERNAME = 'aforo';
    redis.reply = (cmds) => cmds.map((c) => (c[0] === 'AUTH' ? '+OK\r\n' : '$-1\r\n')).join('');
    await call(token());
    assertEquals(JSON.stringify(redis.received[0]), JSON.stringify(['AUTH', 'aforo', 'pw']), 'ACL user name in AUTH');

    // TLS is the default; a plain server cannot complete the handshake.
    useRedis({ tls: 'true' });
    redis.reply = (cmds) => cmds.map(() => '$-1\r\n').join('');
    p = await call(token());
    assertEquals(effect(p), 'Deny', 'REDIS_TLS default (true) against a non-TLS server → Deny');

    // Real TLS round trip when openssl is available to make a test certificate.
    let tlsDir = null;
    try {
        tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aforo-redis-tls-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', path.join(tlsDir, 'key.pem'), '-out', path.join(tlsDir, 'cert.pem'),
            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    } catch {
        tlsDir = null;
    }
    if (tlsDir) {
        const tlsState = { received: [], reply: (cmds) => cmds.map((c) => (c[0] === 'AUTH' ? '+OK\r\n' : '$-1\r\n')).join('') };
        const tlsServer = tls.createServer({
            key: fs.readFileSync(path.join(tlsDir, 'key.pem')),
            cert: fs.readFileSync(path.join(tlsDir, 'cert.pem')),
        }, respHandler(tlsState));
        const tlsPort = await listen(tlsServer);
        useRedis({ port: tlsPort, tls: 'true', auth: 'pw' });
        process.env.REDIS_TLS_SERVERNAME = 'localhost';
        process.env.REDIS_TLS_CA_FILE = path.join(tlsDir, 'cert.pem');
        p = await call(token());
        assertEquals(effect(p), 'Allow', 'TLS + AUTH round trip → Allow');
        assertEquals(tlsState.received[0] && tlsState.received[0][0], 'AUTH', 'AUTH sent over TLS');

        useRedis({ port: tlsPort, tls: 'true' });
        process.env.REDIS_TLS_SERVERNAME = 'localhost'; // no CA file: self-signed cert is rejected
        p = await call(token());
        assertEquals(effect(p), 'Deny', 'untrusted TLS certificate → Deny');
        delete process.env.REDIS_TLS_SERVERNAME;
        await new Promise((r) => tlsServer.close(r));
        fs.rmSync(tlsDir, { recursive: true, force: true });
    } else {
        console.log('  SKIP: openssl not found — TLS round trip not run');
    }

    T.reset();
    delete process.env.REDIS_HOST;
    p = await call(token());
    assertEquals(effect(p), 'Allow', 'no REDIS_HOST → no revocation check (documented)');

    console.log('\nG340: RESP parser');
    const r1 = T.parseRespReplies(Buffer.from('+OK\r\n$3\r\nabc\r\n$-1\r\n-ERR x\r\n:5\r\n'));
    assertEquals(r1.replies.map((r) => r.type).join(','), 'simple,bulk,nil,error,integer', 'reply types');
    assertEquals(r1.replies[1].value, 'abc', 'bulk value');
    const r2 = T.parseRespReplies(Buffer.from('$5\r\nab'));
    assert(r2.replies.length === 0 && r2.used === 0, 'partial bulk waits for more bytes');
    let threw = false;
    try { T.parseRespReplies(Buffer.from('?x\r\n')); } catch { threw = true; }
    assert(threw, 'unknown type byte throws');
    threw = false;
    try { T.parseRespReplies(Buffer.from('$3\r\nabcde\r\n')); } catch { threw = true; }
    assert(threw, 'bulk length mismatch throws');

    console.log('\nG341: Allow covers one stage, Deny one method');
    T.reset();
    delete process.env.REDIS_HOST;
    p = await call(token());
    assertEquals(resource(p), 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*', 'Allow resource is the stage, not the whole API');
    assert(!/:abc123\/\*$/.test(resource(p)), 'not every stage of the API');
    p = await auth.handler({ authorizationToken: 'Bearer nope', methodArn: METHOD_ARN });
    assertEquals(resource(p), METHOD_ARN, 'Deny resource is the called method');
    assertEquals(T.stageArn('not-an-arn'), 'not-an-arn', 'unexpected methodArn shape kept as-is (narrow)');

    console.log('\nG343: unknown kid refetches at most once per 30 s');
    T.reset();
    jwks.hits = 0; jwks.fail = false;
    await call(token());
    assertEquals(jwks.hits, 1, 'first call fetches the JWKS');
    for (let i = 0; i < 5; i++) {
        p = await call(token({ __kid: `forged-${i}` }));
        assertEquals(effect(p), 'Deny', `forged kid ${i} denied`);
    }
    assertEquals(jwks.hits, 2, 'five unknown kids → one refetch (was five)');
    p = await call(token());
    assertEquals(effect(p), 'Allow', 'known kid still verifies');

    T.reset();
    jwks.hits = 0;
    await call(token());
    jwks.fail = true;
    p = await call(token({ __kid: 'rotated' }));
    assertEquals(effect(p), 'Deny', 'unknown kid with JWKS down → Deny');
    p = await call(token());
    assertEquals(effect(p), 'Allow', 'failed refetch keeps the previous key set (known kid still verifies)');
    jwks.fail = false;

    console.log('\nW6.2 review: tenant pinned, issuer required');
    T.reset();
    delete process.env.REDIS_HOST;
    p = await call(token({ tenant_id: 't2' }));
    assertEquals(effect(p), 'Deny', 'token of another tenant → Deny (was Allow)');
    assertEquals(p.context.error, 'TENANT_MISMATCH', 'Deny says TENANT_MISMATCH');
    p = await call(token({ tenant_id: undefined }));
    assertEquals(effect(p), 'Deny', 'token without tenant_id → Deny');
    p = await call(token());
    assertEquals(p.context.tenantId, 't1', 'tenantId in the context is the configured one');

    delete process.env.AFORO_TENANT_ID;
    T.reset();
    p = await call(token());
    assertEquals(effect(p), 'Deny', 'AFORO_TENANT_ID unset → every token denied (fail closed)');
    assertEquals(p.context.error, 'TENANT_NOT_CONFIGURED', 'Deny says the tenant is not configured');
    process.env.AFORO_TENANT_ID = '  ';
    p = await call(token());
    assertEquals(effect(p), 'Deny', 'blank AFORO_TENANT_ID → Deny');
    process.env.AFORO_TENANT_ID = 't1';

    delete process.env.AFORO_JWT_ISSUER;
    T.reset();
    p = await call(token({ iss: 'https://evil.example' }));
    assertEquals(effect(p), 'Deny', 'AFORO_JWT_ISSUER unset → default issuer enforced (was skipped)');
    p = await call(token({ iss: undefined }));
    assertEquals(effect(p), 'Deny', 'token without iss → Deny');
    p = await call(token());
    assertEquals(effect(p), 'Allow', 'default issuer https://auth.aforo.ai accepted');
    process.env.AFORO_JWT_ISSUER_CHECK_DISABLED = 'true';
    p = await call(token({ iss: 'https://other.example' }));
    assertEquals(effect(p), 'Allow', 'AFORO_JWT_ISSUER_CHECK_DISABLED=true skips the issuer check');
    process.env.AFORO_JWT_ISSUER_CHECK_DISABLED = 'yes';
    p = await call(token({ iss: 'https://other.example' }));
    assertEquals(effect(p), 'Deny', 'only the exact value "true" disables the check');
    delete process.env.AFORO_JWT_ISSUER_CHECK_DISABLED;
    process.env.AFORO_JWT_ISSUER = ISS;

    jwksServer.close();
    redisServer.close();
    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
