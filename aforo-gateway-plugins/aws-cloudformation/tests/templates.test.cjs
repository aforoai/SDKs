'use strict';
/**
 * Checks for the two templates (G345, G346, G347). No YAML library (no npm
 * packages), so the checks read the text. Run with:
 *   node aws-cloudformation/tests/templates.test.js
 */
const fs = require('fs');
const path = require('path');

const ROLE = fs.readFileSync(path.join(__dirname, '..', 'aforo-apigateway-role.yaml'), 'utf8');
const DENY = fs.readFileSync(path.join(__dirname, '..', 'aforo-monetized-deny-policy.yaml'), 'utf8');

let passed = 0;
let failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  PASS: ' + msg); } else { failed++; console.error('  FAIL: ' + msg); } }

/** Lines of the block under `<indent><name>:` (until a line at the same or lower indent). */
function block(text, name, indent) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l === `${' '.repeat(indent)}${name}:`
        || l.startsWith(`${' '.repeat(indent)}- Sid: ${name}`) || l === `${' '.repeat(indent)}- ${name}:`);
    if (start < 0) return '';
    const out = [lines[start]];
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() && (l.length - l.trimStart().length) <= indent) break;
        out.push(l);
    }
    return out.join('\n');
}
const statement = (sid) => block(ROLE, sid, 14) || block(ROLE, sid, 16);
const noComments = (t) => t.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const roleCode = noComments(ROLE);

console.log('\nG345: API Gateway read access is scoped and never reads key values');
const read = statement('ReadApiConfiguration');
assert(/Action: apigateway:GET/.test(read), 'read statement allows GET');
const readArns = [...read.matchAll(/'arn:\$\{AWS::Partition\}:apigateway:\$\{Region\}::(\/[^']*)'/g)].map((m) => m[1]);
assert(JSON.stringify(readArns) === JSON.stringify(['/restapis', '/restapis/*', '/apis', '/apis/*', '/usageplans', '/usageplans/*']),
    `GET limited to restapis, apis, usageplans (got ${readArns.join(' ')})`);
assert(!/apigateway:[^:']*::\/\*'/.test(roleCode), 'no apigateway ::/* resource anywhere');
const deny = statement('NeverReadApiKeys');
assert(/Effect: Deny/.test(deny) && /Action: apigateway:GET/.test(deny), 'explicit Deny on GET');
for (const p of ['/apikeys', '/apikeys/*', '/usageplans/*/keys', '/usageplans/*/keys/*']) {
    assert(deny.includes(`::${p}'`), `Deny covers ${p}`);
}
assert(!/apigateway:(POST|PUT|PATCH|DELETE)\b|(Action:|-) '?apigateway:\*/.test(roleCode), 'no API Gateway write actions');
assert(/ApiGatewayRegion:/.test(ROLE) && /UseStackRegion: !Equals \[!Ref ApiGatewayRegion, ''\]/.test(ROLE),
    'region parameter, empty = stack region');
assert(/MeteringInstall: !Equals \[!Ref AllowMeteringInstall, 'true'\]/.test(ROLE), 'metering install (writes) is a separate, optional policy');
assert(!/lambda:\*:/.test(roleCode) && !/logs:\*:\$\{AWS::AccountId\}/.test(roleCode), 'Lambda and Logs ARNs are region-scoped');

console.log('\nG346: subscriptions only on API Gateway log groups');
const sub = statement('SubscribeToApiGatewayLogs');
assert(/logs:PutSubscriptionFilter/.test(sub), 'subscription statement present');
assert(/log-group:\/aws\/apigateway\/\*'/.test(sub) && /log-group:API-Gateway-\*'/.test(sub), 'API Gateway log group prefixes');
assert(/log-group:\$\{AccessLogGroupPrefix\}\*'/.test(sub) && /HasAccessLogGroupPrefix/.test(sub), 'optional custom prefix');
assert(!/log-group:\*'/.test(roleCode), 'no log-group:* resource');
assert(!/GetLogEvents|FilterLogEvents/.test(roleCode), 'role cannot read log events');
const dest = statement('NoLogDestinations');
assert(/Effect: Deny/.test(dest) && /destination:\*'/.test(dest), 'cross-account log destinations denied');
const pass = statement('PassMeteringExecutionRole');
assert(/iam:PassedToService: lambda\.amazonaws\.com/.test(pass), 'only the Lambda execution role can be passed, to Lambda only');
assert(/function:aforo-metering-\*'/.test(statement('MeteringFunction')), 'Lambda actions limited to aforo-metering-*');

console.log('\nG347: parameter constraints and the deny policy attachment');
const ext = block(ROLE, 'ExternalId', 2);
assert(/MinLength: 32/.test(ext), 'ExternalId MinLength 32');
assert(/MaxLength: 44/.test(ext), 'ExternalId MaxLength 44 (fits the execution role name)');
assert(/AllowedPattern: '\^\[A-Za-z0-9-\]\+\$'/.test(ext), 'ExternalId AllowedPattern');
const acct = block(ROLE, 'AforoAccountId', 2);
assert(/AllowedPattern: '\^\\d\{12\}\$'/.test(acct), 'AforoAccountId must be 12 digits');
assert(!/000000000000/.test(ROLE) && !/000000000000/.test(DENY), 'no 000000000000 placeholder');
assert(/AllowedPattern: '\^\(\\d\{12\}\)\?\$'/.test(block(DENY, 'AforoAccountId', 2)), 'deny stack AforoAccountId: empty or 12 digits');
for (const [param, prop, cond] of [['AttachToRoles', 'Roles', 'HasRoles'], ['AttachToUsers', 'Users', 'HasUsers'], ['AttachToGroups', 'Groups', 'HasGroups']]) {
    assert(/Type: CommaDelimitedList/.test(block(DENY, param, 2)), `${param} parameter`);
    assert(new RegExp(`${prop}: !If \\[${cond}, !Ref ${param}, !Ref AWS::NoValue\\]`).test(DENY), `policy attached to ${param} when given`);
}
assert(/Effect: Deny/.test(DENY) && /aws:ResourceTag\/aforo-monetized/.test(DENY), 'deny policy still denies tagged deletes');

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
process.exit(failed ? 1 : 0);
