'use strict';
/*
 * Safety checks for the demo stack (G369, G370).
 *
 *   node demo/scripts/tests/demo-safety.test.js
 *
 * - The Kong Admin API is not reachable from outside the Kong container.
 * - Nothing the browser can fetch carries the ingest API key.
 * - The generator refuses an Aforo production endpoint unless
 *   DEMO_ALLOW_PRODUCTION=true.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEMO = path.join(__dirname, '..', '..');
const SCRIPT = path.join(DEMO, 'scripts', 'generate-keys-and-config.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${name}\n        ${err.message}`);
  }
}

const IDENTITY = {
  DEMO_TENANT_ID: 'tenant_demo',
  DEMO_CUSTOMER_ID: 'cust_demo',
  DEMO_TEAM_ID: 'team_demo',
  DEMO_KEY_ID: 'key_demo_0001',
  DEMO_SUBSCRIPTION_ID: 'sub_demo',
};
const SECRET = 'sk_live_THIS_MUST_NEVER_REACH_THE_BROWSER_0123';

/** A throwaway copy of the demo layout the generator writes into. */
function tempDemo(envLines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aforo-demo-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'nirmala-frontend'));
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'generate-keys-and-config.js'));
  fs.writeFileSync(path.join(root, '.env'), envLines.join('\n') + '\n');
  return root;
}

function run(root) {
  // A clean environment so the developer's own DEMO_* variables cannot leak in.
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'generate-keys-and-config.js')], {
    cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
}

function identityLines(extra = {}) {
  return Object.entries({ ...IDENTITY, ...extra }).map(([k, v]) => `${k}=${v}`);
}

console.log('\nG369: Kong Admin API');

const compose = fs.readFileSync(path.join(DEMO, 'docker-compose.yml'), 'utf8');

test('Admin API listens on the container loopback only', () => {
  const m = compose.match(/^\s*KONG_ADMIN_LISTEN:\s*"?([^"\s]+)"?/m);
  assert.ok(m, 'KONG_ADMIN_LISTEN not set');
  assert.ok(m[1].startsWith('127.0.0.1:'), `KONG_ADMIN_LISTEN is ${m[1]}`);
});

test('the Admin API port is not published on the host', () => {
  const published = compose.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^-\s*"?[^"]*:8001"?\s*$/.test(l));
  assert.deepStrictEqual(published, [], `published: ${published.join(', ')}`);
});

test('no host port is published on every interface', () => {
  const ports = compose.split('\n').map((l) => l.trim())
    .filter((l) => /^-\s*"?\$?\{?[A-Z_]*:?-?\d*\}?:\d+"?$/.test(l) || /^-\s*"\d+:\d+"$/.test(l));
  assert.deepStrictEqual(ports, [], `bound to 0.0.0.0: ${ports.join(', ')}`);
});

console.log('\nKong shared dicts');

test('the demo declares both aforo_buffer and aforo_cache, as the plugin image does', () => {
  const m = compose.match(/^\s*KONG_NGINX_HTTP_LUA_SHARED_DICT:\s*"([^"]*)"/m);
  assert.ok(m, 'KONG_NGINX_HTTP_LUA_SHARED_DICT not set');
  assert.ok(/(^|;\s*lua_shared_dict\s+)aforo_buffer\s+\d+[km]\b/.test(m[1]), m[1]);
  assert.ok(/;\s*lua_shared_dict\s+aforo_cache\s+\d+[km]\b/.test(m[1]), 'aforo_cache missing: ' + m[1]);
  const docker = fs.readFileSync(path.join(DEMO, '..', 'kong', 'Dockerfile'), 'utf8');
  const img = docker.match(/KONG_NGINX_HTTP_LUA_SHARED_DICT="([^"]*)"/);
  assert.ok(img, 'Dockerfile value not found');
  for (const dict of ['aforo_buffer', 'aforo_cache']) assert.ok(img[1].includes(dict), 'Dockerfile lacks ' + dict);
});

console.log('\nG370: secrets in the served folder');

test('the frontend tokens.json carries no API key', () => {
  const root = tempDemo(identityLines({ DEMO_INGEST_API_KEY: SECRET }));
  const r = run(root);
  assert.strictEqual(r.status, 0, r.stderr);
  const served = fs.readFileSync(path.join(root, 'nirmala-frontend', 'tokens.json'), 'utf8');
  assert.ok(!served.includes(SECRET), 'ingest API key written into nirmala-frontend/tokens.json');
  assert.ok(!/ingestApiKey|apiKey|api_key/i.test(served), 'an api key field is present');
  const t = JSON.parse(served);
  for (const k of ['valid', 'expired', 'forged']) assert.ok(t[k], `${k} token missing`);
  for (const k of ['kongUrl', 'ingestorUrl', 'tenantId', 'teamId', 'customerId', 'keyId']) {
    assert.ok(t.config[k], `config.${k} missing (the page reads it)`);
  }
});

test('the scripts copy carries no API key either (kong.yml is the only place it lives)', () => {
  const root = tempDemo(identityLines({ DEMO_INGEST_API_KEY: SECRET }));
  assert.strictEqual(run(root).status, 0);
  const scripts = fs.readFileSync(path.join(root, 'scripts', '.tokens.json'), 'utf8');
  assert.ok(!scripts.includes(SECRET));
  const kong = fs.readFileSync(path.join(root, 'kong', 'kong.yml'), 'utf8');
  assert.ok(kong.includes(SECRET), 'Kong still needs the key in kong.yml');
});

test('the generator refuses an Aforo production endpoint by default', () => {
  const root = tempDemo(identityLines({
    DEMO_INGEST_API_KEY: SECRET,
    DEMO_AFORO_ENDPOINT: 'https://api.aforo.ai/v1/ingest/batch',
  }));
  const r = run(root);
  assert.notStrictEqual(r.status, 0, 'generator accepted a production endpoint');
  assert.match(r.stderr, /DEMO_ALLOW_PRODUCTION/);
  assert.ok(!fs.existsSync(path.join(root, 'kong', 'kong.yml')), 'kong.yml written anyway');
  assert.ok(!fs.existsSync(path.join(root, 'nirmala-frontend', 'tokens.json')), 'tokens.json written anyway');
});

test('a production browser URL (ingestor) is refused too', () => {
  const root = tempDemo(identityLines({ DEMO_INGESTOR_URL: 'https://api.aforo.ai' }));
  const r = run(root);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /DEMO_INGESTOR_URL/);
});

test('DEMO_ALLOW_PRODUCTION=true lets a production endpoint through', () => {
  const root = tempDemo(identityLines({
    DEMO_INGEST_API_KEY: SECRET,
    DEMO_AFORO_ENDPOINT: 'https://api.aforo.ai/v1/ingest/batch',
    DEMO_INGESTOR_URL: 'https://api.aforo.ai',
    DEMO_ALLOW_PRODUCTION: 'true',
  }));
  const r = run(root);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('look-alike hosts are not mistaken for production', () => {
  const root = tempDemo(identityLines({
    DEMO_AFORO_ENDPOINT: 'https://api.aforo.ai.example.test/v1/ingest/batch',
    DEMO_INGESTOR_URL: 'https://notaforo.ai',
  }));
  const r = run(root);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('a production endpoint needs a real ingest key, not the placeholder', () => {
  const root = tempDemo(identityLines({
    DEMO_INGEST_API_KEY: 'YOUR_INGEST_API_KEY',
    DEMO_AFORO_ENDPOINT: 'https://api.aforo.ai/v1/ingest/batch',
    DEMO_ALLOW_PRODUCTION: 'true',
  }));
  const r = run(root);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /DEMO_INGEST_API_KEY/);
});

test('the production example does not opt in on the operator\'s behalf', () => {
  const ex = fs.readFileSync(path.join(DEMO, '.env.production.example'), 'utf8');
  const line = ex.split('\n').find((l) => /^\s*DEMO_ALLOW_PRODUCTION\s*=/.test(l));
  assert.ok(line, 'DEMO_ALLOW_PRODUCTION missing from .env.production.example');
  assert.ok(!/=\s*true\s*$/.test(line), 'example opts in to production by default');
});

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
process.exit(failed > 0 ? 1 : 0);
