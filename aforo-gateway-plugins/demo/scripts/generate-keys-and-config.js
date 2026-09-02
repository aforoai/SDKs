#!/usr/bin/env node
/*
 * Generates the RS256 keypair the demo signs tokens with, mints a demo JWT for
 * Nirmala, and renders kong/kong.yml with the matching public key.
 *
 * The keypair is generated fresh rather than committed, so nothing in this repo
 * is a usable credential. Re-run whenever you want to reset the demo.
 *
 * The claims mirror what organization-service actually issues (JwtTokenService):
 * tenant_id, customer_id, key_id, subscription_ids, scopes, environment. key_id
 * is the claim the metering plugin forwards as metadata.keyId, which is what
 * lets the ingestor attribute the event to a team.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/*
 * docker compose reads .env automatically; this reads the same file so the two
 * cannot drift. Getting that wrong is not cosmetic -- the page would point at
 * whatever else is listening on :8000 and every call would fail with a CORS
 * error that has nothing to do with CORS.
 */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}

const dotenv = loadDotEnv();
const env = (name, fallback) => process.env[name] || dotenv[name] || fallback;

const KONG_PORT = env('KONG_PROXY_PORT', '8000');
const INGESTOR_PORT = env('INGESTOR_PORT', '8084');

const CONFIG = {
  issuer: 'https://auth.aforo.ai',
  // Deliberately placeholders, not working values. A default that happens to
  // work is worse than none here: it produces a demo that runs, meters into
  // somebody else's tenant, and looks fine while doing it.
  tenantId: env('DEMO_TENANT_ID', 'YOUR_TENANT_ID'),
  customerId: env('DEMO_CUSTOMER_ID', 'YOUR_CUSTOMER_ID'),
  teamId: env('DEMO_TEAM_ID', 'YOUR_TEAM_ID'),
  keyId: env('DEMO_KEY_ID', 'YOUR_API_KEY_ID'),
  subscriptionId: env('DEMO_SUBSCRIPTION_ID', 'YOUR_SUBSCRIPTION_ID'),
  aforoEndpoint: env('DEMO_AFORO_ENDPOINT', `http://host.docker.internal:${INGESTOR_PORT}/v1/ingest/batch`),
  upstream: env('DEMO_UPSTREAM', 'http://suchith-backend:9000'),
  // Browser-facing URLs. The page reads these instead of hardcoding a port.
  kongUrl: env('DEMO_KONG_URL', `http://localhost:${KONG_PORT}`),
  ingestorUrl: env('DEMO_INGESTOR_URL', `http://localhost:${INGESTOR_PORT}`),
  // Redis, as seen from inside the Kong container. The plugin defaults to
  // 127.0.0.1, which inside a container is the container itself -- hence
  // "connection refused" on every jti/revocation check.
  // Metric names, which must exist in your Aforo catalog.
  readMetric: env('DEMO_READ_METRIC', 'api_calls'),
  orderMetric: env('DEMO_ORDER_METRIC', 'api_calls'),
  redisHost: env('DEMO_REDIS_HOST', 'host.docker.internal'),
  redisPort: env('DEMO_REDIS_PORT', '6379'),
};

/*
 * Refuse to generate anything while a placeholder survives.
 *
 * Without this the demo starts happily, signs tokens claiming tenant
 * "YOUR_TENANT_ID", and every event is silently dropped or misattributed --
 * surfacing much later as an empty budget panel or a 403 that looks like an
 * auth bug. Failing here, naming the exact variables, costs one run and saves
 * that whole investigation.
 */
const REQUIRED = ['tenantId', 'customerId', 'teamId', 'keyId', 'subscriptionId'];
const missing = REQUIRED.filter((k) => String(CONFIG[k] || '').startsWith('YOUR_'));
if (missing.length) {
  const varNames = { tenantId: 'DEMO_TENANT_ID', customerId: 'DEMO_CUSTOMER_ID',
                     teamId: 'DEMO_TEAM_ID', keyId: 'DEMO_KEY_ID',
                     subscriptionId: 'DEMO_SUBSCRIPTION_ID' };
  console.error('\nRefusing to generate: these still hold placeholder values.\n');
  for (const k of missing) console.error(`  ${varNames[k]}  (currently ${CONFIG[k]})`);
  console.error(`
Set them in .env, then re-run.

  cp .env.example .env            # local Aforo stack
  cp .env.production.example .env # Aforo production

Where each value comes from is in README.md, "Where to find these values".
DEMO_TEAM_ID is the one people skip: without it usage still bills correctly,
but team budgets never apply and summary-by-team stays empty.
`);
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(payload, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: CONFIG.issuer,
  sub: CONFIG.customerId,
  tenant_id: CONFIG.tenantId,
  customer_id: CONFIG.customerId,
  key_id: CONFIG.keyId,
  subscription_ids: [CONFIG.subscriptionId],
  scopes: 'usage:ingest',
  environment: 'live',
  iat: now,
  exp: now + 24 * 3600,
  jti: crypto.randomUUID(),
};

const token = sign(claims, privateKey);

// An expired token, so the demo can show a rejection that is NOT a bad signature.
const expired = sign({ ...claims, jti: crypto.randomUUID(), iat: now - 7200, exp: now - 3600 }, privateKey);

// A token with identical claims signed by a DIFFERENT key: the forgery case.
const { privateKey: attackerKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const forged = sign({ ...claims, jti: crypto.randomUUID() }, attackerKey);

const indent = (pem, spaces) =>
  pem.trim().split('\n').map((l) => ' '.repeat(spaces) + l).join('\n');

const kongYml = `# Generated by scripts/generate-keys-and-config.js -- do not edit by hand.
_format_version: "3.0"

services:
  - name: suchith-backend
    url: ${CONFIG.upstream}
    routes:
      - name: suchith-api
        paths: ["/api"]
        strip_path: false
    plugins:
      # MUST come before aforo-metering. Kong's cors plugin runs at priority
      # ~2000 while aforo-metering runs at 5, so cors handles the OPTIONS
      # preflight and short-circuits first. Without it the demo breaks twice
      # over in a browser: preflight requests carry no Authorization header, so
      # JWT validation 401s them and POST /api/orders can never succeed; and
      # Kong's own 401s carry no CORS headers, so a rejected token surfaces as
      # an opaque network error instead of the clean 401 this demo exists to
      # show.
      - name: cors
        config:
          origins: ["*"]
          methods: ["GET", "POST", "OPTIONS"]
          headers: ["Authorization", "Content-Type"]
          credentials: false
          preflight_continue: false
      - name: aforo-metering
        config:
          tenant_id: ${CONFIG.tenantId}
          aforo_endpoint: ${CONFIG.aforoEndpoint}
          api_key: demo-ingest-key

          # Verify the RS256 signature. With jwt_public_key set, an unverifiable
          # token is rejected -- jwt_allow_unverified_signature stays false.
          jwt_validation_enabled: true
          jwt_issuer: ${CONFIG.issuer}
          jwt_public_key: |
${indent(publicKey, 12)}

          # JTI blocklist + client-revocation lookups. The plugin's default of
          # 127.0.0.1 resolves to the Kong container itself, so every check
          # failed with "connection refused". These checks are fail-open, so
          # validation still worked -- but revocation was silently unenforced,
          # which is exactly the kind of quiet gap not to ship.
          jwt_redis_host: ${CONFIG.redisHost}
          jwt_redis_port: ${CONFIG.redisPort}

          # Endpoint -> metric. Without this the plugin falls back to
          # "{method} {path}", producing a metric per endpoint that the catalog
          # does not know, and every event is rejected as an unknown metric.
          # These names must exist in YOUR catalog -- edit to match.
          metric_mappings:
            - path_pattern: "^/api/orders"
              metric_name: ${CONFIG.orderMetric}
            - path_pattern: "^/api/products"
              metric_name: ${CONFIG.readMetric}
          default_metric: ${CONFIG.readMetric}

          # Flush quickly so the demo does not sit waiting.
          flush_interval_ms: 2000
          flush_count: 5
          include_metadata: true
`;

fs.mkdirSync(path.join(ROOT, 'kong'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'kong', 'kong.yml'), kongYml);

const tokens = { valid: token, expired, forged, claims, config: CONFIG };
fs.writeFileSync(path.join(ROOT, 'nirmala-frontend', 'tokens.json'), JSON.stringify(tokens, null, 2));
fs.writeFileSync(path.join(ROOT, 'scripts', '.tokens.json'), JSON.stringify(tokens, null, 2));

console.log('Wrote kong/kong.yml, nirmala-frontend/tokens.json, scripts/.tokens.json');
console.log(`  tenant=${CONFIG.tenantId} customer=${CONFIG.customerId} key_id=${CONFIG.keyId}`);
console.log('  tokens: valid / expired / forged');
