// Every plugin sends the Aforo API key as X-API-Key, never as a Bearer token,
// and no default points at a host other than api.aforo.ai.
// Run: node tests/ingest-auth-standard.test.cjs
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const senders = [
  'kong/handler.lua',
  'aws-lambda/index.js',
  'aws-lambda/compound-metering.js',
  'aws-lambda/preflight-quota.js',
  'apigee/sharedflowbundle/policies/AforoMeteringSendEvent.xml',
  'apigee/sharedflowbundle/policies/AforoMeteringSendEventRetry1.xml',
  'azure-apim/outbound-policy.xml',
  'azure-apim/compound-metering-policy-fragment.xml',
  'azure-apim/preflight-quota-policy-fragment.xml',
];
// MuleSoft's template moved during packaging work; accept either location.
const mule = ['mulesoft/template.xml', 'mulesoft/aforo-metering/src/main/mule/template.xml']
  .find((f) => fs.existsSync(path.join(root, f)));
if (mule) senders.push(mule);

// A Bearer token built from the configured Aforo key, in any of the five syntaxes.
const bearerKey = /Bearer\s*("\s*\.\.\s*\(?conf\.api_key|\$\{(AFORO_API_KEY|config\.apiKey|aforo-api-key)\}|\{private\.aforo\.apiKey\}|\{\{aforo-api-key\}\}|\{context\.Variables\.GetValueOrDefault<string>\("aforo-api-key"\))/;

let failed = 0;
let passed = 0;
function check(ok, msg) {
  if (ok) { passed++; } else { failed++; console.error('FAIL: ' + msg); }
}

for (const f of senders) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  check(src.includes('X-API-Key'), `${f} sends X-API-Key`);
  check(!bearerKey.test(src), `${f} does not send the API key as a Bearer token`);
}

const sam = fs.readFileSync(path.join(root, 'aws-lambda/template.yaml'), 'utf8');
check(sam.includes('Default: https://api.aforo.ai/v1/ingest/batch'), 'SAM default endpoint is api.aforo.ai');
check(!/ingest\.aforo\.ai/.test(sam), 'SAM template does not name ingest.aforo.ai');

console.log(`ingest-auth-standard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
