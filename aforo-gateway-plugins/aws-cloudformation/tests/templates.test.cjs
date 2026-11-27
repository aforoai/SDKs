'use strict';
/**
 * Checks for the two templates (G345, G346, G347, AllowGatewayOrchestration, and the 3.2.2
 * one-click hardening G336, G338, G339). No npm packages: most checks read the text; the
 * 3.2.0+ checks resolve the role template for given parameters with ./cfn.cjs and evaluate
 * the resulting policies. Run with:
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
// PUT replaces whole resources (PUT /restapis/{id}). The one PUT allowed (3.2.1) is the tag-on-create
// of new usage plans and API keys, inside the opt-in policy.
const tagStmt = statement('TagNewUsagePlansAndKeys');
assert(tagStmt && orchestrationPolicy.includes(tagStmt), 'TagNewUsagePlansAndKeys sits in the opt-in AforoGatewayOrchestration policy');
assert(!/apigateway:PUT\b|(Action:|-) '?apigateway:\*/.test(noComments(ROLE.replace(tagStmt, ''))),
    'no apigateway:PUT or apigateway:* action anywhere else');
const tagArns = [...tagStmt.matchAll(/'arn:\$\{AWS::Partition\}:apigateway:\$\{Region\}::(\/[^']*)'/g)].map((m) => m[1]);
assert(JSON.stringify(tagArns) === JSON.stringify([
    '/tags/arn%3A${AWS::Partition}%3Aapigateway%3A${Region}%3A%3A%2Fusageplans%2F*',
    '/tags/arn%3A${AWS::Partition}%3Aapigateway%3A${Region}%3A%3A%2Fapikeys%2F*']),
    `PUT only on the tags of usage plans and API keys (got ${tagArns.join(' ')})`);
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
const V321 = cfn.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'aforo-apigateway-role-3.2.1.yaml'), 'utf8'));
const EXT = '0b0e7c8e-6c1a-4c6e-9a8e-3a1f2b4c5d6e';
const ACCT = '111122223333';
const BUCKET = 'arn:aws:s3:::acme-aforo-firehose-backup';
const OWN_FIREHOSE_ROLE = `arn:aws:iam::${ACCT}:role/acme-firehose`;
const OWN_LOGS_ROLE = `arn:aws:iam::${ACCT}:role/acme-logs-to-firehose`;
const stmts = (r) => cfn.roleStatements(r, 'AforoRole');
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/**
 * What 3.2.2 adds, and only with AllowMeteringInstall=true (G336, G338, G339): three statements
 * in AforoMeteringInstall, two Lambda actions in MeteringFunction, and the execution role's
 * AforoMeteringFailureQueue policy (whose Description names it). without322() removes exactly
 * these from a resolved stack, so the comparisons below show nothing else changed.
 */
const ADDED_322_SIDS = ['MeteringFailureQueue', 'MeteringFailureAlarm', 'MeteringFunctionLogGroup'];
const ADDED_322_LAMBDA = ['lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency'];
const EXEC_DESCRIPTION_322 = ', sends to its failure queue';
function without322(resources) {
    const r = JSON.parse(JSON.stringify(resources));
    for (const p of (r.AforoRole && r.AforoRole.Properties.Policies) || []) {
        p.PolicyDocument.Statement = p.PolicyDocument.Statement
            .filter((x) => !ADDED_322_SIDS.includes(x.Sid))
            .map((x) => (x.Sid === 'MeteringFunction'
                ? { ...x, Action: [].concat(x.Action).filter((a) => !ADDED_322_LAMBDA.includes(a)) } : x));
    }
    const exec = r.AforoMeteringExecutionRole;
    if (exec) {
        exec.Properties.Policies = exec.Properties.Policies.filter((p) => p.PolicyName !== 'AforoMeteringFailureQueue');
        exec.Properties.Description = exec.Properties.Description.replace(EXEC_DESCRIPTION_322, '');
    }
    return r;
}

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
                if (canonical(was.Resources) === canonical(without322(now.Resources))
                    && canonical(was.Outputs) === canonical(now.Outputs)) {
                    identical++;
                } else {
                    console.error('    differs for ' + JSON.stringify({ ...base, ...extra }));
                }
            }
        }
    }
}
assert(combos === 36 && identical === combos,
    `resolved resources and outputs identical to 3.1.0 (apart from the 3.2.2 metering additions) for all ${combos} parameter combinations (${identical} identical)`);

console.log('\n3.2.2: nothing changes but the metering-install additions (compared with 3.2.1)');
let combos322 = 0;
let same322 = 0;
let meteringOffIdentical = 0;
for (const AllowMeteringInstall of ['true', 'false']) {
    for (const AllowGatewayOrchestration of ['true', 'false']) {
        for (const ApiGatewayRegion of ['', '*', 'eu-west-1']) {
            for (const AccessLogGroupPrefix of ['', 'acme/access-logs']) {
                for (const extra of [{}, { FirehoseBackupBucketArn: BUCKET },
                    { FirehoseRoleArn: OWN_FIREHOSE_ROLE, CloudWatchLogsRoleArn: OWN_LOGS_ROLE }]) {
                    const params = { ExternalId: EXT, AllowMeteringInstall, AllowGatewayOrchestration, ApiGatewayRegion,
                        AccessLogGroupPrefix, ...extra };
                    const was = cfn.resolve(V321, params);
                    const now = cfn.resolve(NEW, params);
                    combos322++;
                    if (canonical(was.Resources) === canonical(without322(now.Resources))
                        && canonical(was.Outputs) === canonical(now.Outputs)) {
                        same322++;
                    } else {
                        console.error('    differs for ' + JSON.stringify(params));
                    }
                    if (AllowMeteringInstall === 'false' && canonical(was.Resources) === canonical(now.Resources)) {
                        meteringOffIdentical++;
                    }
                }
            }
        }
    }
}
assert(combos322 === 72 && same322 === combos322,
    `3.2.1 plus exactly the 3.2.2 additions, for all ${combos322} parameter combinations (${same322} match)`);
assert(meteringOffIdentical === 36, `AllowMeteringInstall=false: identical to 3.2.1 (${meteringOffIdentical}/36)`);

/**
 * The resource AWS authorises a tag-on-create against: apigateway:PUT on /tags/ + the new
 * resource's URL-encoded ARN, with '*' for the id it does not have yet. Seen live (W6.2
 * T-6.2.8 step 4a): ".../tags/arn%3Aaws%3Aapigateway%3Aus-east-1%3A%3A%2Fusageplans%2F*".
 */
function tagsOf(R, path) {
    return `arn:aws:apigateway:${R}::/tags/` + encodeURIComponent(`arn:aws:apigateway:${R}::${path}`);
}
assert(tagsOf('us-east-1', '/usageplans/*') === 'arn:aws:apigateway:us-east-1::/tags/arn%3Aaws%3Aapigateway%3Aus-east-1%3A%3A%2Fusageplans%2F*',
    'tagsOf() builds the resource string AWS reported in the live AccessDenied');

const off = cfn.resolve(NEW, { ExternalId: EXT });
for (const [action, resource] of [
    ['apigateway:POST', 'arn:aws:apigateway:us-east-1::/usageplans'],
    ['apigateway:GET', 'arn:aws:apigateway:us-east-1::/apikeys/k1'],
    ['apigateway:GET', 'arn:aws:apigateway:us-east-1::/usageplans/p1/keys'],
    ['cloudwatch:GetMetricData', '*'],
    ['firehose:CreateDeliveryStream', `arn:aws:firehose:us-east-1:${ACCT}:deliverystream/aforo-gateway-1234abcd`],
    ['apigateway:PUT', tagsOf('us-east-1', '/usageplans/*')],
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
        ['CreateUsagePlan tags', 'apigateway:PUT', tagsOf(R, '/usageplans/*')],
        ['CreateApiKey tags', 'apigateway:PUT', tagsOf(R, '/apikeys/*')],
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
    assert(missing.length === 0, `${label}: all 21 adapter calls allowed${missing.length ? ' (denied: ' + missing.join(', ') + ')' : ''}`);
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
    ['tag a REST API', 'apigateway:PUT', tagsOf('us-east-1', '/restapis/a1')],
    ['tag a stage', 'apigateway:PUT', tagsOf('us-east-1', '/restapis/a1/stages/prod')],
    ['tag a usage plan in another region', 'apigateway:PUT', tagsOf('eu-west-1', '/usageplans/*')],
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

// ── 3.2.2: one-click metering hardening (G336, G338, G339) ──────────────────────
console.log('\n3.2.2: the one-click install may create its failure queue, alarm, concurrency and log retention');
const FN = 'aforo-metering-1234abcd';
/** Every call organization-service's one-click install (deploy and remove) makes, as [what, action, resource, context]. */
function meteringCalls(R, accessLogGroup) {
    const fn = `arn:aws:lambda:${R}:${ACCT}:function:${FN}`;
    const queue = `arn:aws:sqs:${R}:${ACCT}:${FN}-failures`;
    const alarm = `arn:aws:cloudwatch:${R}:${ACCT}:alarm:${FN}-failures`;
    const fnLogs = `arn:aws:logs:${R}:${ACCT}:log-group:/aws/lambda/${FN}`;
    const secret = `arn:aws:secretsmanager:${R}:${ACCT}:secret:aforo/metering/${FN}-AbCdEf`;
    const access = `arn:aws:logs:${R}:${ACCT}:log-group:${accessLogGroup}`;
    return [
        ['DescribeLogGroups', 'logs:DescribeLogGroups', '*'],
        ...['DescribeSecret', 'CreateSecret', 'PutSecretValue', 'RestoreSecret', 'DeleteSecret', 'TagResource']
            .map((a) => [a, `secretsmanager:${a}`, secret]),
        ...['CreateQueue', 'GetQueueUrl', 'GetQueueAttributes', 'SetQueueAttributes', 'TagQueue', 'DeleteQueue']
            .map((a) => [a, `sqs:${a}`, queue]),
        ...['CreateLogGroup', 'PutRetentionPolicy', 'TagResource'].flatMap((a) => [
            [`${a} (log group)`, `logs:${a}`, fnLogs], [`${a} (log group :*)`, `logs:${a}`, `${fnLogs}:*`]]),
        ...['GetFunctionConfiguration', 'CreateFunction', 'UpdateFunctionCode', 'UpdateFunctionConfiguration',
            'PutFunctionEventInvokeConfig', 'PutFunctionConcurrency', 'DeleteFunctionConcurrency', 'RemovePermission',
            'AddPermission', 'DeleteFunction', 'TagResource'].map((a) => [a, `lambda:${a}`, fn]),
        ['PassRole', 'iam:PassRole', `arn:aws:iam::${ACCT}:role/AforoMeteringExecutionRole`,
            { 'iam:PassedToService': 'lambda.amazonaws.com' }],
        ...['PutMetricAlarm', 'DeleteAlarms', 'TagResource'].map((a) => [a, `cloudwatch:${a}`, alarm]),
        ['PutSubscriptionFilter', 'logs:PutSubscriptionFilter', access],
        ['DeleteSubscriptionFilter', 'logs:DeleteSubscriptionFilter', access],
    ];
}
for (const [label, params, R] of [
    ['stack region', {}, 'us-east-1'],
    ['ApiGatewayRegion=eu-west-1', { ApiGatewayRegion: 'eu-west-1' }, 'eu-west-1'],
    ['ApiGatewayRegion=*', { ApiGatewayRegion: '*' }, 'ap-south-1'],
    ['with AllowGatewayOrchestration=true', { AllowGatewayOrchestration: 'true' }, 'us-east-1'],
]) {
    const m = cfn.resolve(NEW, { ExternalId: EXT, ...params });
    const calls = meteringCalls(R, '/aws/apigateway/orders-access');
    const missing = calls.filter(([, a, r, c]) => !cfn.allows(stmts(m), a, r, c || {})).map(([n]) => n);
    assert(missing.length === 0, `${label}: all ${calls.length} one-click calls allowed${missing.length ? ' (denied: ' + missing.join(', ') + ')' : ''}`);
    const exec = cfn.roleStatements(m, 'AforoMeteringExecutionRole');
    assert(cfn.allows(exec, 'sqs:SendMessage', `arn:aws:sqs:${R}:${ACCT}:${FN}-failures`),
        `${label}: the execution role can send to the failure queue (OnFailure destination)`);
}

const m322 = cfn.resolve(NEW, { ExternalId: EXT });
const exec322 = cfn.roleStatements(m322, 'AforoMeteringExecutionRole');
for (const [what, action, resource] of [
    ['read the failure queue', 'sqs:ReceiveMessage', `arn:aws:sqs:us-east-1:${ACCT}:${FN}-failures`],
    ['send messages to the failure queue', 'sqs:SendMessage', `arn:aws:sqs:us-east-1:${ACCT}:${FN}-failures`],
    ['purge the failure queue', 'sqs:PurgeQueue', `arn:aws:sqs:us-east-1:${ACCT}:${FN}-failures`],
    ['create a queue not named aforo-metering-*', 'sqs:CreateQueue', `arn:aws:sqs:us-east-1:${ACCT}:orders-dlq`],
    ['change another queue', 'sqs:SetQueueAttributes', `arn:aws:sqs:us-east-1:${ACCT}:orders-dlq`],
    ['delete another queue', 'sqs:DeleteQueue', `arn:aws:sqs:us-east-1:${ACCT}:orders-dlq`],
    ['create a queue in another region', 'sqs:CreateQueue', `arn:aws:sqs:eu-west-1:${ACCT}:${FN}-failures`],
    ['put another alarm', 'cloudwatch:PutMetricAlarm', `arn:aws:cloudwatch:us-east-1:${ACCT}:alarm:orders-5xx`],
    ['delete another alarm', 'cloudwatch:DeleteAlarms', `arn:aws:cloudwatch:us-east-1:${ACCT}:alarm:orders-5xx`],
    ['change the retention of the API access logs', 'logs:PutRetentionPolicy', `arn:aws:logs:us-east-1:${ACCT}:log-group:/aws/apigateway/orders-access`],
    ['change the retention of another function\'s logs', 'logs:PutRetentionPolicy', `arn:aws:logs:us-east-1:${ACCT}:log-group:/aws/lambda/orders`],
    ['create another log group', 'logs:CreateLogGroup', `arn:aws:logs:us-east-1:${ACCT}:log-group:/aws/lambda/orders`],
    ['delete the function\'s log group', 'logs:DeleteLogGroup', `arn:aws:logs:us-east-1:${ACCT}:log-group:/aws/lambda/${FN}`],
    ['read the function\'s logs', 'logs:GetLogEvents', `arn:aws:logs:us-east-1:${ACCT}:log-group:/aws/lambda/${FN}:*`],
    ['reserve concurrency on another function', 'lambda:PutFunctionConcurrency', `arn:aws:lambda:us-east-1:${ACCT}:function:orders`],
]) {
    assert(!cfn.allows(stmts(m322), action, resource), `metering on: Aforo cannot ${what}`);
}
assert(!cfn.allows(exec322, 'sqs:SendMessage', `arn:aws:sqs:us-east-1:${ACCT}:orders-dlq`),
    'execution role cannot send to a queue not named aforo-metering-*');
assert(!cfn.allows(exec322, 'sqs:ReceiveMessage', `arn:aws:sqs:us-east-1:${ACCT}:${FN}-failures`),
    'execution role cannot read the failure queue');
assert(!stmts(m322).some((x) => [].concat(x.Action).some((a) => /^(sqs|cloudwatch|logs):\*$/.test(a))),
    'no sqs:*, cloudwatch:* or logs:* action');

const off322 = cfn.resolve(NEW, { ExternalId: EXT, AllowMeteringInstall: 'false', AllowGatewayOrchestration: 'true',
    FirehoseBackupBucketArn: BUCKET });
const offAllowed = meteringCalls('us-east-1', '/aws/lambda/x').filter(([, a, r, c]) => /^(sqs|cloudwatch:(Put|Delete|Tag)|logs:(CreateLogGroup|PutRetentionPolicy|TagResource)|lambda:)/.test(a)
    && cfn.allows(stmts(off322), a, r, c || {})).map(([n, a]) => `${n} ${a}`);
assert(offAllowed.length === 0, `metering off: no queue, alarm, log group or Lambda call allowed${offAllowed.length ? ' (allowed: ' + offAllowed.join(', ') + ')' : ''}`);
assert(!off322.Resources.AforoMeteringExecutionRole, 'metering off: no execution role');

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
process.exit(failed ? 1 : 0);
