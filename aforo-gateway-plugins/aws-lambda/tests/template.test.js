'use strict';
/**
 * template.yaml checks for G337 (key in Secrets Manager), G338 (reserved
 * concurrency, batch size) and G339 (subscription filter, arm64, log
 * retention). cfn-lint validates the template's shape; these tests pin the
 * decisions. No YAML library (no npm packages), so the checks read the text.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const T = fs.readFileSync(path.join(__dirname, '..', 'template.yaml'), 'utf8');

let passed = 0;
let failed = 0;
function assert(condition, msg) {
    if (condition) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); }
}

/** The indented block under a top-level `<name>:` key inside a section. */
function block(name, indent = 2) {
    const lines = T.split('\n');
    const start = lines.findIndex((l) => l === `${' '.repeat(indent)}${name}:`);
    if (start < 0) return '';
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() && (l.length - l.trimStart().length) <= indent) break;
        out.push(l);
    }
    return out.join('\n');
}
function paramDefault(name) {
    const m = block(name).match(/^\s+Default:\s*(.*)$/m);
    if (!m) return undefined;
    const v = m[1].trim();
    return v.startsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v;
}
const FUNCTIONS = ['AforoMeteringFunction', 'AforoMeteringProxyFunction', 'AforoKeyAuthorizerFunction'];

console.log('\nG337: the Aforo key comes from Secrets Manager');
const metering = block('AforoMeteringFunction');
const authorizer = block('AforoKeyAuthorizerFunction');
assert(!/^\s+AFORO_API_KEY:/m.test(T), 'no AFORO_API_KEY environment variable in the template');
assert(!/^\s+AFORO_TENANT_KEY:/m.test(T), 'no AFORO_TENANT_KEY environment variable in the template');
assert(/AFORO_API_KEY_SECRET_ARN: !Ref AforoApiKeySecretArn/.test(metering), 'metering function gets the secret ARN');
assert(/AFORO_TENANT_KEY_SECRET_ARN: !Ref AforoTenantKeySecretArn/.test(authorizer), 'authorizer gets the tenant-key secret ARN');
assert(/AWSSecretsManagerGetSecretValuePolicy:\s*\n\s+SecretArn: !Ref AforoApiKeySecretArn/.test(metering),
    'metering function may read exactly that secret');
assert(/AWSSecretsManagerGetSecretValuePolicy:\s*\n\s+SecretArn: !Ref AforoTenantKeySecretArn/.test(authorizer),
    'authorizer may read exactly its secret');
assert(!/secretsmanager:\*|Resource: '\*'/.test(T), 'no wildcard secret access');
assert(paramDefault('AforoApiKeySecretArn') === undefined, 'AforoApiKeySecretArn has no default (required)');
assert(/AllowedPattern: .*secretsmanager/.test(block('AforoApiKeySecretArn')), 'AforoApiKeySecretArn must be a secret ARN');
for (const name of ['AforoApiKeySecretArn', 'AforoTenantKeySecretArn']) {
    const m = block(name).match(/AllowedPattern: '([^']+)'/);
    assert(m, name + ' has an AllowedPattern');
    const re = new RegExp(m[1]);
    assert(re.test('arn:aws:secretsmanager:eu-west-1:123456789012:secret:aforo/metering/api-key-AbCdEf'),
        name + ' accepts a full ARN (with the six-character suffix)');
    assert(!re.test('arn:aws:secretsmanager:eu-west-1:123456789012:secret:aforo/metering/api-key'),
        name + ' refuses a partial ARN (the IAM grant would match nothing)');
}
const rules = T.slice(T.indexOf('\nRules:'), T.indexOf('\nConditions:'));
assert(/!Equals \[!Ref AforoApiKey, ''\]/.test(rules), 'a rule refuses a plaintext AforoApiKey');
assert(/!Equals \[!Ref AforoTenantKey, ''\]/.test(rules), 'a rule refuses a plaintext AforoTenantKey');
assert(/AssertDescription: .*AforoApiKeySecretArn/s.test(rules), 'the refusal says what to use instead');
assert(/kms:Decrypt/.test(T) && /kms:ViaService/.test(T), 'optional customer-managed KMS key, limited to Secrets Manager');

console.log('\nG338: reserved concurrency and batch size');
assert(/ReservedConcurrentExecutions: !If \[HasReservedConcurrency, !Ref ReservedConcurrency, !Ref AWS::NoValue\]/.test(metering),
    'metering function reserves concurrency');
assert(paramDefault('ReservedConcurrency') === '10', 'ReservedConcurrency defaults to 10');
assert(/FLUSH_COUNT: !Ref FlushCount/.test(metering), 'FLUSH_COUNT comes from a parameter');
assert(paramDefault('FlushCount') === '500', 'FlushCount defaults to 500');
assert(/MaxValue: 1000/.test(block('FlushCount')), 'FlushCount capped at the ingestor limit (1000)');
assert(!/ReservedConcurrentExecutions/.test(block('AforoMeteringProxyFunction')) &&
    !/ReservedConcurrentExecutions/.test(authorizer), 'request-path functions are not capped');

console.log('\nG339: architecture and log retention');
const globals = T.slice(T.indexOf('\nGlobals:'), T.indexOf('\nParameters:'));
assert(/Architectures:\s*\n\s+- arm64/.test(globals), 'every function runs on arm64 (Globals)');
for (const fn of FUNCTIONS) {
    assert(!/x86_64/.test(block(fn)), `${fn} does not override to x86_64`);
}
const meteringLogs = block('AforoMeteringLogGroup');
assert(/Type: AWS::Logs::LogGroup/.test(meteringLogs) && /RetentionInDays: !Ref LogRetentionDays/.test(meteringLogs),
    'metering function log group has retention');
assert(/LoggingConfig:\s*\n\s+LogGroup: !Ref AforoMeteringLogGroup/.test(metering), 'metering function logs to it');
assert(/LoggingConfig:\s*\n\s+LogGroup: !Ref AforoKeyAuthorizerLogGroup/.test(authorizer), 'authorizer logs to a retained group');
assert(/RetentionInDays: !Ref LogRetentionDays/.test(block('AforoMeteringProxyLogGroup')), 'proxy log group uses the same retention');
assert(paramDefault('LogRetentionDays') === '14', 'LogRetentionDays defaults to 14');

console.log('\nG339: the access-log subscription filter forwards only metering records');
const filterPattern = paramDefault('AccessLogFilterPattern');
assert(filterPattern && filterPattern !== '', `filter is not empty (${filterPattern})`);
assert(/FilterPattern: !Ref AccessLogFilterPattern/.test(block('AforoMeteringSubscriptionFilter')),
    'the access-log filter uses the parameter');

/**
 * CloudWatch Logs term matching for one quoted term ("a") or an OR pattern of
 * quoted terms (?"a" ?"b"): an event matches when it contains a term,
 * case-sensitive. Other pattern shapes are refused so the test cannot pass on
 * a pattern it does not understand.
 */
function matches(pattern, message) {
    const single = pattern.match(/^"([^"]+)"$/);
    if (single) return message.includes(single[1]);
    const terms = [...pattern.matchAll(/\?"([^"]+)"/g)].map((m) => m[1]);
    if (terms.length === 0 || pattern.replace(/\?"[^"]+"/g, '').trim() !== '') {
        throw new Error(`unsupported pattern shape: ${pattern}`);
    }
    return terms.some((t) => message.includes(t));
}

process.env.AFORO_API_KEY = 'k';
process.env.MCP_ENABLED = 'true';
const { parseAccessLog, buildUsageEvent } = require('../index');
const billable = (message) => {
    const parsed = parseAccessLog(message);
    if (!parsed) return false;
    const r = buildUsageEvent(parsed, { id: 'e', timestamp: 1767225600000, message });
    return !r.skip && r.events && r.events.length > 0;
};

const proxyRecord = { aforoUsage: 1, requestId: 'p1', httpMethod: 'POST', path: '/mcp', status: 200,
    customerId: 'cust_1', agentId: 'agent_1', mcp: [{ toolName: 'search' }] };
const samples = [
    JSON.stringify({ requestId: 'a', httpMethod: 'GET', resourcePath: '/v1/a', status: '200', customerId: 'cust_1' }),
    JSON.stringify({ requestId: 'b', httpMethod: 'GET', resourcePath: '/v1/a', status: '200', caller: 'AROAEXAMPLE:alice' }),
    JSON.stringify({ requestId: 'c', httpMethod: 'GET', resourcePath: '/v1/a', status: '200', 'authorizer.customerId': 'cust_2' }),
    JSON.stringify(proxyRecord),
    `2026-10-27T10:00:00.000Z\tabc-123\tINFO\t${JSON.stringify(proxyRecord)}`,
    JSON.stringify({ time: 'x', level: 'INFO', message: JSON.stringify(proxyRecord) }),
    JSON.stringify({ time: 'x', level: 'INFO', message: proxyRecord }),
    // Not billable: no identity, CLF, a Lambda platform line.
    JSON.stringify({ requestId: 'd', httpMethod: 'GET', resourcePath: '/v1/a', status: '200' }),
    '10.0.0.1 - - [01/Jan/2026:00:00:00 +0000] "GET /a HTTP/1.1" 200 12',
    'START RequestId: 123 Version: $LATEST',
];
let billableCount = 0;
for (const line of samples) {
    if (billable(line)) {
        billableCount++;
        assert(matches(filterPattern, line), `billable line reaches the function: ${line.slice(0, 70)}`);
    }
}
assert(billableCount >= 6, `fixture covers every accepted format (${billableCount} billable)`);
assert(!matches(filterPattern, 'START RequestId: 123 Version: $LATEST'), 'Lambda platform lines are filtered out');
assert(!matches(filterPattern, samples[8]), 'CLF lines (never billable) are filtered out');
assert(matches(block('AforoMeteringProxySubscriptionFilter').match(/FilterPattern: '(.*)'/)[1], samples[4]),
    'proxy filter still matches a prefixed proxy record');
void zlib;

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
process.exit(failed > 0 ? 1 : 0);
