'use strict';
/**
 * Checks for the two templates (G345, G346, G347, AllowGatewayOrchestration). No npm
 * packages: most checks read the text; the 3.2.0 checks resolve the role template for
 * given parameters with ./cfn.cjs and evaluate the resulting policies. Run with:
 *   node aws-cloudformation/tests/templates.test.cjs
 */
const fs = require('fs');
const path = require('path');
const cfn = require('./cfn.cjs');

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
const orchestrationPolicy = ROLE.slice(ROLE.indexOf('PolicyName: AforoGatewayOrchestration'),
    ROLE.indexOf('  AforoMeteringExecutionRole:'));
const outsideOrchestration = noComments(ROLE.replace(orchestrationPolicy, ''));
assert(orchestrationPolicy.length > 0 && !/apigateway:(POST|PUT|PATCH|DELETE)\b|(Action:|-) '?apigateway:\*/.test(outsideOrchestration),
    'no API Gateway write actions outside the opt-in AforoGatewayOrchestration policy');
assert(!/apigateway:PUT\b|(Action:|-) '?apigateway:\*/.test(roleCode), 'no apigateway:PUT or apigateway:* action anywhere');
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

console.log('\nW6: the one-click install keeps the Aforo API key in Secrets Manager');
const secretArn = "'arn:${AWS::Partition}:secretsmanager:${Region}:${AWS::AccountId}:secret:aforo/metering/*'";
const secret = statement('MeteringApiKeySecret');
const secretActions = [...secret.matchAll(/- (secretsmanager:\w+)/g)].map((m) => m[1]).sort();
assert(JSON.stringify(secretActions) === JSON.stringify(['secretsmanager:CreateSecret', 'secretsmanager:DeleteSecret',
    'secretsmanager:DescribeSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:RestoreSecret',
    'secretsmanager:TagResource']), `Aforo role: write/describe/delete the secret only (got ${secretActions.join(' ')})`);
assert(secret.includes(secretArn), 'Aforo role: secrets limited to aforo/metering/* in the metering region');
const meteringPolicy = block(ROLE, 'MeteringInstall', 10) || ROLE.slice(ROLE.indexOf('PolicyName: AforoMeteringInstall'),
    ROLE.indexOf('AforoMeteringExecutionRole:'));
assert(meteringPolicy.includes('MeteringApiKeySecret'), 'secret statement is part of the optional metering policy');
assert(!/secretsmanager:GetSecretValue/.test(ROLE.slice(0, ROLE.indexOf('AforoMeteringExecutionRole:'))),
    'Aforo role cannot read the secret back');
const execRole = ROLE.slice(ROLE.indexOf('  AforoMeteringExecutionRole:'), ROLE.indexOf('  AforoFirehoseDeliveryRole:'));
assert(/Condition: MeteringInstall/.test(execRole), 'execution role only with AllowMeteringInstall');
assert(/Action: secretsmanager:GetSecretValue/.test(execRole) && execRole.includes(secretArn.replace(/^'|'$/g, "'")),
    'execution role reads aforo/metering/* secrets');
assert(!/secretsmanager:\*/.test(roleCode) && !/secret:\*'/.test(roleCode), 'no secretsmanager:* and no secret:* resource');

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

// ── 3.2.0: AllowGatewayOrchestration ─────────────────────────────────────────────
const NEW = cfn.parse(ROLE);
const OLD = cfn.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'aforo-apigateway-role-3.1.0.yaml'), 'utf8'));
const EXT = '0b0e7c8e-6c1a-4c6e-9a8e-3a1f2b4c5d6e';
const ACCT = '111122223333';
const BUCKET = 'arn:aws:s3:::acme-aforo-firehose-backup';
const OWN_FIREHOSE_ROLE = `arn:aws:iam::${ACCT}:role/acme-firehose`;
const OWN_LOGS_ROLE = `arn:aws:iam::${ACCT}:role/acme-logs-to-firehose`;
const stmts = (r) => cfn.roleStatements(r, 'AforoRole');
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

console.log('\n3.2.0: AllowGatewayOrchestration=false grants exactly what 3.1.0 granted');
assert(/AllowGatewayOrchestration:\n {4}Type: String\n {4}Default: 'false'/.test(ROLE), 'AllowGatewayOrchestration defaults to false');
let combos = 0;
let identical = 0;
for (const AllowMeteringInstall of ['true', 'false']) {
    for (const ApiGatewayRegion of ['', '*', 'eu-west-1']) {
        for (const AccessLogGroupPrefix of ['', 'acme/access-logs']) {
            for (const extra of [{}, { FirehoseBackupBucketArn: BUCKET },
                { FirehoseRoleArn: OWN_FIREHOSE_ROLE, CloudWatchLogsRoleArn: OWN_LOGS_ROLE }]) {
                const base = { ExternalId: EXT, AllowMeteringInstall, ApiGatewayRegion, AccessLogGroupPrefix };
                const was = cfn.resolve(OLD, base);
                const now = cfn.resolve(NEW, { ...base, ...extra });
                combos++;
                if (canonical(was.Resources) === canonical(now.Resources) && canonical(was.Outputs) === canonical(now.Outputs)) {
                    identical++;
                } else {
                    console.error('    differs for ' + JSON.stringify({ ...base, ...extra }));
                }
            }
        }
    }
}
assert(combos === 36 && identical === combos,
    `resolved resources and outputs identical to 3.1.0 for all ${combos} parameter combinations (${identical} identical)`);

const off = cfn.resolve(NEW, { ExternalId: EXT });
for (const [action, resource] of [
    ['apigateway:POST', 'arn:aws:apigateway:us-east-1::/usageplans'],
    ['apigateway:GET', 'arn:aws:apigateway:us-east-1::/apikeys/k1'],
    ['apigateway:GET', 'arn:aws:apigateway:us-east-1::/usageplans/p1/keys'],
    ['cloudwatch:GetMetricData', '*'],
    ['firehose:CreateDeliveryStream', `arn:aws:firehose:us-east-1:${ACCT}:deliverystream/aforo-gateway-1234abcd`],
]) {
    assert(!cfn.allows(stmts(off), action, resource), `off: ${action} ${resource.replace(/^arn:aws:[a-z]+:[^:]*:[^:]*:/, '')} not allowed`);
}

console.log('\n3.2.0: AllowGatewayOrchestration=true allows every call the organization-service AWS adapters make');
/** Each call, as [what it is, action, resource, context]. R = API Gateway / logs / Firehose region. */
function adapterCalls(R, logGroup) {
    const ag = (p) => `arn:aws:apigateway:${R}::${p}`;
    const stream = `arn:aws:firehose:${R}:${ACCT}:deliverystream/aforo-gateway-1234abcd`;
    const lg = `arn:aws:logs:${R}:${ACCT}:log-group:${logGroup}`;
    return [
        ['CreateUsagePlan', 'apigateway:POST', ag('/usageplans')],
        ['GetUsagePlan', 'apigateway:GET', ag('/usageplans/p1')],
        ['GetUsagePlans ?keyId=', 'apigateway:GET', ag('/usageplans')],
        ['UpdateUsagePlan', 'apigateway:PATCH', ag('/usageplans/p1')],
        ['DeleteUsagePlan', 'apigateway:DELETE', ag('/usageplans/p1')],
        ['CreateApiKey', 'apigateway:POST', ag('/apikeys')],
        ['CreateUsagePlanKey', 'apigateway:POST', ag('/usageplans/p1/keys')],
        ['GetUsagePlanKeys', 'apigateway:GET', ag('/usageplans/p1/keys')],
        ['GetApiKey', 'apigateway:GET', ag('/apikeys/k1')],
        ['UpdateApiKey', 'apigateway:PATCH', ag('/apikeys/k1')],
        ['DeleteApiKey', 'apigateway:DELETE', ag('/apikeys/k1')],
        ['GetRestApi', 'apigateway:GET', ag('/restapis/a1')],
        ['GetMetricData', 'cloudwatch:GetMetricData', '*'],
        ['CreateDeliveryStream', 'firehose:CreateDeliveryStream', stream],
        ['DescribeDeliveryStream', 'firehose:DescribeDeliveryStream', stream],
        ['UpdateDestination', 'firehose:UpdateDestination', stream],
        ['DeleteDeliveryStream', 'firehose:DeleteDeliveryStream', stream],
        ['PutSubscriptionFilter', 'logs:PutSubscriptionFilter', lg],
        ['DeleteSubscriptionFilter', 'logs:DeleteSubscriptionFilter', lg],
    ];
}
for (const [label, params, R] of [
    ['stack region, metering on', { AllowMeteringInstall: 'true' }, 'us-east-1'],
    ['stack region, metering off', { AllowMeteringInstall: 'false' }, 'us-east-1'],
    ['ApiGatewayRegion=eu-west-1', { ApiGatewayRegion: 'eu-west-1', AllowMeteringInstall: 'false' }, 'eu-west-1'],
    ['ApiGatewayRegion=*', { ApiGatewayRegion: '*', AllowMeteringInstall: 'false' }, 'ap-south-1'],
]) {
    const on = cfn.resolve(NEW, { ExternalId: EXT, AllowGatewayOrchestration: 'true', FirehoseBackupBucketArn: BUCKET, ...params });
    const missing = adapterCalls(R, `/aws/apigateway/a1/prod`).filter(([, a, r]) => !cfn.allows(stmts(on), a, r)).map(([n]) => n);
    assert(missing.length === 0, `${label}: all 19 adapter calls allowed${missing.length ? ' (denied: ' + missing.join(', ') + ')' : ''}`);
    const passFirehose = cfn.allows(stmts(on), 'iam:PassRole', `arn:aws:iam::${ACCT}:role/AforoFirehoseDeliveryRole`,
        { 'iam:PassedToService': 'firehose.amazonaws.com' });
    const passLogs = cfn.allows(stmts(on), 'iam:PassRole', `arn:aws:iam::${ACCT}:role/AforoLogsToFirehoseRole`,
        { 'iam:PassedToService': 'logs.amazonaws.com' });
    assert(passFirehose && passLogs, `${label}: PassRole of the two created roles to their services`);
}

const on = cfn.resolve(NEW, { ExternalId: EXT, AllowGatewayOrchestration: 'true', FirehoseBackupBucketArn: BUCKET });
const deniedSid = stmts(on).find((x) => x.Sid === 'NeverReadApiKeys');
assert(deniedSid && JSON.stringify(deniedSid.Resource) === JSON.stringify(['arn:aws:apigateway:*::/apikeys', 'arn:aws:apigateway:*::/usageplans/*/keys/*']),
    'on: NeverReadApiKeys keeps denying GET /apikeys and GET /usageplans/*/keys/*, drops the two paths the adapters read');
for (const [what, action, resource, context] of [
    ['list every API key (GET /apikeys?includeValues=true)', 'apigateway:GET', 'arn:aws:apigateway:us-east-1::/apikeys'],
    ['GET /usageplans/p1/keys/k1', 'apigateway:GET', 'arn:aws:apigateway:us-east-1::/usageplans/p1/keys/k1'],
    ['GET /apikeys in another region', 'apigateway:GET', 'arn:aws:apigateway:eu-west-1::/apikeys/k1'],
    ['POST /usageplans in another region', 'apigateway:POST', 'arn:aws:apigateway:eu-west-1::/usageplans'],
    ['PUT /restapis/a1 (replace an API)', 'apigateway:PUT', 'arn:aws:apigateway:us-east-1::/restapis/a1'],
    ['DELETE /restapis/a1', 'apigateway:DELETE', 'arn:aws:apigateway:us-east-1::/restapis/a1'],
    ['a Firehose stream not named aforo-gateway-*', 'firehose:DeleteDeliveryStream', `arn:aws:firehose:us-east-1:${ACCT}:deliverystream/orders`],
    ['firehose:PutRecord as Aforo', 'firehose:PutRecord', `arn:aws:firehose:us-east-1:${ACCT}:deliverystream/aforo-gateway-1234abcd`],
    ['subscribe a non-API Gateway log group', 'logs:PutSubscriptionFilter', `arn:aws:logs:us-east-1:${ACCT}:log-group:/aws/lambda/orders`],
    ['a cross-account log destination', 'logs:PutSubscriptionFilter', `arn:aws:logs:us-east-1:${ACCT}:destination:x`],
    ['read log events', 'logs:GetLogEvents', `arn:aws:logs:us-east-1:${ACCT}:log-group:/aws/apigateway/a1/prod`],
    ['pass the Firehose role to Lambda', 'iam:PassRole', `arn:aws:iam::${ACCT}:role/AforoFirehoseDeliveryRole`, { 'iam:PassedToService': 'lambda.amazonaws.com' }],
    ['pass the Logs role to Firehose', 'iam:PassRole', `arn:aws:iam::${ACCT}:role/AforoLogsToFirehoseRole`, { 'iam:PassedToService': 'firehose.amazonaws.com' }],
    ['pass any other role', 'iam:PassRole', `arn:aws:iam::${ACCT}:role/Admin`, { 'iam:PassedToService': 'firehose.amazonaws.com' }],
    ['create an IAM role', 'iam:CreateRole', `arn:aws:iam::${ACCT}:role/x`],
    ['write the backup bucket as Aforo', 's3:PutObject', `${BUCKET}/x`],
]) {
    assert(!cfn.allows(stmts(on), action, resource, context || {}), `on: cannot ${what}`);
}
const iamActions = stmts(on).flatMap((x) => [].concat(x.Action)).filter((a) => a.startsWith('iam:'));
assert(iamActions.every((a) => a === 'iam:PassRole'), 'on: the only IAM action is iam:PassRole');
assert(stmts(on).filter((x) => [].concat(x.Action).includes('iam:PassRole')).every((x) => x.Condition && x.Condition.StringEquals
    && x.Condition.StringEquals['iam:PassedToService']), 'on: every PassRole is limited by iam:PassedToService');
assert(!stmts(on).some((x) => x.Effect === 'Allow' && [].concat(x.Resource).includes('*')
    && [].concat(x.Action).some((a) => a !== 'cloudwatch:GetMetricData' && a !== 'logs:DescribeLogGroups')),
    'on: Resource "*" only for cloudwatch:GetMetricData and logs:DescribeLogGroups');

console.log('\n3.2.0: the created push-ingestion roles');
const fh = on.Resources.AforoFirehoseDeliveryRole;
const lr = on.Resources.AforoLogsToFirehoseRole;
assert(fh && lr, 'both roles created with a backup bucket');
const trust = (role) => role.Properties.AssumeRolePolicyDocument.Statement;
assert(canonical(trust(fh)) === canonical([{ Effect: 'Allow', Principal: { Service: 'firehose.amazonaws.com' }, Action: 'sts:AssumeRole',
    Condition: { StringEquals: { 'sts:ExternalId': ACCT } } }]), 'Firehose role: only Firehose in this account can assume it');
assert(canonical(trust(lr)) === canonical([{ Effect: 'Allow', Principal: { Service: 'logs.amazonaws.com' }, Action: 'sts:AssumeRole',
    Condition: { StringLike: { 'aws:SourceArn': `arn:aws:logs:us-east-1:${ACCT}:*` } } }]), 'Logs role: only CloudWatch Logs in this account and region');
const fhStmts = cfn.roleStatements(on, 'AforoFirehoseDeliveryRole');
assert(canonical(fhStmts.map((x) => [x.Effect, x.Action, x.Resource])) === canonical([['Allow',
    ['s3:AbortMultipartUpload', 's3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:ListBucketMultipartUploads', 's3:PutObject'],
    [BUCKET, `${BUCKET}/*`]]]), 'Firehose role: the six S3 actions Firehose needs, on the backup bucket only');
const lrStmts = cfn.roleStatements(on, 'AforoLogsToFirehoseRole');
assert(canonical(lrStmts.map((x) => [x.Effect, x.Action, x.Resource])) === canonical([['Allow', ['firehose:PutRecord', 'firehose:PutRecordBatch'],
    `arn:aws:firehose:us-east-1:${ACCT}:deliverystream/aforo-gateway-*`]]), 'Logs role: PutRecord/PutRecordBatch on aforo-gateway-* only');
assert(canonical(Object.keys(on.Outputs).sort()) === canonical(['AforoMeteringExecutionRoleArn', 'AforoRoleArn', 'CloudWatchLogsRoleArn',
    'FirehoseBackupBucketArn', 'FirehoseRoleArn']) && on.Outputs.FirehoseBackupBucketArn === BUCKET,
    'outputs FirehoseRoleArn, CloudWatchLogsRoleArn, FirehoseBackupBucketArn');

console.log('\n3.2.0: your own roles instead');
const own = cfn.resolve(NEW, { ExternalId: EXT, AllowGatewayOrchestration: 'true', FirehoseRoleArn: OWN_FIREHOSE_ROLE, CloudWatchLogsRoleArn: OWN_LOGS_ROLE });
assert(!own.Resources.AforoFirehoseDeliveryRole && !own.Resources.AforoLogsToFirehoseRole && !own.Outputs.FirehoseRoleArn,
    'no roles created and no role outputs without a backup bucket');
assert(cfn.allows(stmts(own), 'iam:PassRole', OWN_FIREHOSE_ROLE, { 'iam:PassedToService': 'firehose.amazonaws.com' })
    && cfn.allows(stmts(own), 'iam:PassRole', OWN_LOGS_ROLE, { 'iam:PassedToService': 'logs.amazonaws.com' }), 'PassRole of the two given roles');
assert(!cfn.allows(stmts(own), 'iam:PassRole', OWN_FIREHOSE_ROLE, { 'iam:PassedToService': 'logs.amazonaws.com' }), 'given Firehose role cannot go to CloudWatch Logs');
const none = cfn.resolve(NEW, { ExternalId: EXT, AllowGatewayOrchestration: 'true' });
assert(!stmts(none).some((x) => [].concat(x.Action).includes('iam:PassRole') && x.Sid !== 'PassMeteringExecutionRole'),
    'no roles given and no bucket: no Firehose / Logs PassRole (usage plans, keys and metrics still work)');
let ruleError = '';
try { cfn.resolve(NEW, { ExternalId: EXT, AllowGatewayOrchestration: 'true', FirehoseBackupBucketArn: BUCKET, FirehoseRoleArn: OWN_FIREHOSE_ROLE }); } catch (e) { ruleError = e.message; }
assert(/CreatedOrOwnEventRoles/.test(ruleError), 'a backup bucket together with your own role ARNs is refused (Rules)');
for (const [p, v] of [['FirehoseBackupBucketArn', 'acme-bucket'], ['FirehoseRoleArn', 'acme-firehose'], ['CloudWatchLogsRoleArn', 'arn:aws:iam::1:role/x']]) {
    let err = '';
    try { cfn.resolve(NEW, { ExternalId: EXT, [p]: v }); } catch (e) { err = e.message; }
    assert(/fails AllowedPattern/.test(err), `${p}=${v} rejected by AllowedPattern`);
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
process.exit(failed ? 1 : 0);
