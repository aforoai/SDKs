/**
 * MuleSoft policy checks — run with `node mulesoft/tests/policy.test.cjs`.
 *
 * DataWeave cannot be executed here (no Mule runtime, no DataWeave CLI),
 * so this file does NOT prove the script evaluates correctly. It proves:
 *   1. The package is complete: pom.xml (packaging mule-policy),
 *      mule-artifact.json, aforo-metering.yaml and src/main/mule/template.xml
 *      exist, and the template and the definition agree on every property.
 *   2. template.xml is well-formed XML (xmllint when installed), wraps the
 *      flow in http-policy:proxy / source / execute-next, meters inside an
 *      async scope, and makes no outbound call for an empty events array.
 *   3. The metering script in template.xml (the only copy) keeps its
 *      exclusion block identical to mcp-mule-policy.yaml, declares the
 *      documented defaults, and gates the events array.
 *   4. Idempotency keys are unchanged (Rule #21).
 *   5. The 2.2.0 merge: productType on every event, metric mappings and
 *      the default metric, OPTIONS / no-identity / long-customer / zero
 *      quantity produce no event, the deprecated alias properties exist
 *      and are read second, 408 is retried, X-API-Key is the only
 *      credential header.
 * Behaviour is covered by the black-box matrix in policy-contract.md,
 * which needs a deployed API.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(DIR, f), 'utf8'); };
const PKG = 'aforo-metering';
const DEFINITION = PKG + '/aforo-metering.yaml';
const TEMPLATE = path.join(DIR, PKG, 'src/main/mule/template.xml');
const BEGIN = '// >>> BEGIN metering script — the only copy; tests/policy.test.cjs locks its invariants';
const END = '// <<< END shared script';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL: ' + name + (detail !== undefined ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
    check(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// The DataWeave under `afterResponse: |`, dedented, without the
// `%dw 2.0` / `output` header lines (the template supplies its own).
function scriptOf(yamlFile) {
    const text = read(yamlFile);
    const at = text.indexOf('  afterResponse: |\n');
    if (at === -1) throw new Error(yamlFile + ': afterResponse block not found');
    const lines = text.slice(at + '  afterResponse: |\n'.length).split('\n').map(function (l) {
        if (l.trim() === '') return '';
        if (!l.startsWith('    ')) throw new Error(yamlFile + ': line outside the block scalar: ' + l);
        return l.slice(4);
    });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}
function sharedBody(yamlFile) {
    const lines = scriptOf(yamlFile);
    if (lines[0] !== '%dw 2.0' || lines[1] !== 'output application/json') {
        throw new Error(yamlFile + ': script must start with "%dw 2.0" / "output application/json"');
    }
    return lines.slice(2).join('\n').replace(/^\n+/, '');
}
function between(text, a, b) {
    const i = text.indexOf(a);
    const j = text.indexOf(b, i + a.length);
    return i === -1 || j === -1 ? null : text.slice(i + a.length, j);
}

const template = fs.readFileSync(TEMPLATE, 'utf8');
const definition = read(DEFINITION);

// ── 1. Package ───────────────────────────────────────────────────────
const mainBody = between(template, BEGIN + '\n', '\n' + END);
check('template.xml carries the metering-script markers', mainBody !== null);
if (mainBody === null) { console.error('cannot continue without the script'); process.exit(1); }
check('metering script cannot terminate the CDATA section', mainBody.indexOf(']]>') === -1);
{
    const pom = read(PKG + '/pom.xml');
    check('pom packaging is mule-policy', pom.indexOf('<packaging>mule-policy</packaging>') !== -1);
    check('pom artifactId matches the definition file name', pom.indexOf('<artifactId>aforo-metering</artifactId>') !== -1);
    check('pom uses mule-maven-plugin as an extension',
        /<artifactId>mule-maven-plugin<\/artifactId>\s*<version>[^<]+<\/version>\s*<extensions>true<\/extensions>/.test(pom));
    check('pom publishes the definition as classifier policy-definition',
        pom.indexOf('<classifier>policy-definition</classifier>') !== -1 && pom.indexOf('<packaging>yaml</packaging>') !== -1);
    check('pom deploys to the Exchange Maven facade for the organization',
        pom.indexOf('https://maven.anypoint.mulesoft.com/api/v3/organizations/${anypoint.org.id}/maven') !== -1);
    const version = (pom.match(/<artifactId>aforo-metering<\/artifactId>\s*<version>([^<]+)<\/version>/) || [])[1];
    check('pom version is a release version', /^\d+\.\d+\.\d+$/.test(version || ''), version);
    eq('pom version equals the VERSION file', version, read('VERSION').trim());
    eq('VERSION', read('VERSION').trim(), '2.2.0');
    let artifact = null;
    try { artifact = JSON.parse(read(PKG + '/mule-artifact.json')); } catch (e) { /* reported below */ }
    check('mule-artifact.json parses and sets minMuleVersion', artifact !== null && /^4\./.test(artifact.minMuleVersion || ''));
    eq('definition id', (definition.match(/^id: (.*)$/m) || [])[1], 'aforo-metering');
    check('definition has no template block (API Manager schema)', !/^template:/m.test(definition));
    check('definition marks the API key sensitive',
        /- propertyName: aforo-api-key\n(?:    .*\n)*?    sensitive: true\n/.test(definition));

    // Every Handlebars name the template renders is declared, and every
    // declared property is rendered.
    const builtin = ['policyId', 'encrypted'];
    const declared = (definition.match(/^  - propertyName: (.+)$/gm) || []).map(function (l) { return l.replace('  - propertyName: ', ''); });
    const used = {};
    (template.match(/\{\{\{[^}]+\}\}\}|\{\{#if [^}]+\}\}/g) || []).forEach(function (m) {
        used[m.replace(/^\{\{\{|\}\}\}$|^\{\{#if |\}\}$/g, '')] = true;
    });
    Object.keys(used).forEach(function (name) {
        check('template property ' + name + ' is declared in the definition',
            builtin.indexOf(name) !== -1 || declared.indexOf(name) !== -1);
    });
    declared.forEach(function (name) {
        check('declared property ' + name + ' is used by the template', used[name] === true);
    });
    eq('declared properties', declared.join(','),
        'aforo-endpoint,aforo-api-key,aforo-tenant-id,customer-id-claim,tenant-id-claim,mcp-enabled,mcp-product-id,status-outcomes,exclude-status-codes,exclude-paths,' +
        'product-type,default-metric,metric-mappings,quantity-source,include-metadata,' +
        'product_type,default_metric,quantity_source,include_metadata');
    // The one-click installer (organization-service) sets these names.
    ['aforo-endpoint', 'aforo-api-key', 'aforo-tenant-id', 'exclude-status-codes', 'exclude-paths', 'status-outcomes'].forEach(function (name) {
        check('installer property ' + name + ' still declared', declared.indexOf(name) !== -1);
    });
    // Only the three the installer always sets are required; a new required
    // property would make every existing policy instance invalid.
    eq('required properties',
        (definition.match(/^  - propertyName: .+\n(?:    .*\n)*?    optional: false$/gm) || [])
            .map(function (b) { return b.split('\n')[0].replace('  - propertyName: ', ''); }).join(','),
        'aforo-endpoint,aforo-api-key,aforo-tenant-id');
    // Mule property placeholders would be resolved against the API's own
    // properties, not the policy configuration. Only the two the gateway
    // itself supplies for encryption are allowed.
    const placeholders = (template.match(/\$\{[^}]+\}/g) || []).filter(function (m) {
        return m !== '${anypoint.platform.encryption_key}' && m !== '${encryptedPropertiesFile}';
    });
    eq('no Mule property placeholders for policy configuration', placeholders.join(','), '');
}

// ── 2. Transport ─────────────────────────────────────────────────────
const lint = spawnSync('xmllint', ['--noout', TEMPLATE], { encoding: 'utf8' });
if (lint.error) {
    console.log('note: xmllint not installed — template.xml well-formedness not checked');
} else {
    eq('template.xml is well formed (xmllint)', lint.status, 0);
    if (lint.status !== 0) console.error(lint.stderr);
}
{
    const gate = template.indexOf('<when expression="#[sizeOf(payload.events default []) > 0]">');
    const send = template.indexOf('<http:request ');
    const gateEnd = template.indexOf('</when>', gate);
    const next = template.indexOf('<http-policy:execute-next/>');
    check('outbound call is gated on a non-empty events array', gate !== -1 && gate < send && send < gateEnd);
    eq('exactly one outbound request', (template.match(/<http:request /g) || []).length, 1);
    check('no <otherwise> branch anywhere', template.indexOf('<otherwise') === -1);
    check('no <choose> element (the Mule router is <choice>)', template.indexOf('<choose') === -1);
    check('policy wraps the flow: proxy > source > execute-next',
        template.indexOf('<http-policy:proxy name="{{{policyId}}}-aforo-metering">') !== -1 &&
        template.indexOf('<http-policy:source>') < next && next !== -1 &&
        (template.match(/<http-policy:execute-next\/>/g) || []).length === 1);
    check('metering runs after the flow, inside async', next < template.indexOf('<async>'));
    check('request capture cannot fail the API call',
        template.indexOf('<try>') < next && template.indexOf('<on-error-continue type="ANY" logException="false"/>') < next);
    check('request id is minted once, before the flow', template.indexOf('requestId: uuid(),') !== -1 && template.indexOf('requestId: uuid(),') < next);
    check('request id is not taken from a client header',
        template.indexOf('correlationId') === -1 && !/requestId: [^\n]*headers/.test(template));
    check('identity comes from verified JWT claims', template.indexOf('authentication.properties.claims') !== -1);
    check('try() resolves to dw::Runtime and yields the value',
        template.indexOf('fun try(delegate) = dw::Runtime::try(delegate).result') !== -1);
    check('payload is built before the retry scope',
        template.lastIndexOf('</ee:transform>') < template.indexOf('<until-successful'));
    check('retried: transport, 5xx, 408 and 429; other 4xx accepted and logged',
        template.indexOf('<http:success-status-code-validator values="200..299,400..407,409..428,430..499" />') !== -1 &&
        template.indexOf('usage event rejected by the ingestor, not retried') > template.indexOf('</until-successful>'));
    {
        const headers = between(template, '<http:headers><![CDATA[#[{', '}]]]></http:headers>') || '';
        eq('ingestor headers are Content-Type and X-API-Key only',
            (headers.match(/"[^"]+":/g) || []).join(''), '"Content-Type":"X-API-Key":');
    }
    check('unusable metric name is logged at WARN, other skips at DEBUG',
        /<when expression="#\[payload\.skipReason == 'metric'\]">\s*<logger level="WARN"/.test(template) &&
        /<when expression="#\[payload\.skipReason != null\]">\s*<logger level="DEBUG"/.test(template));
    check('response body is not read for quantity',
        template.indexOf("responseContentLength: dw::Runtime::try(() -> (attributes.headers.'content-length' as Number)).result") !== -1);
    check('vars.aforo is only a fallback behind the verified claims',
        template.indexOf("customerId: if (claimCustomer != '') claimCustomer else text(prior.customerId)") !== -1);
    check('retry kept: 2 retries inside async',
        /<until-successful maxRetries="2" millisBetweenRetries="1000">/.test(template) &&
        template.indexOf('<async>') < template.indexOf('<until-successful'));
    ['x-customer-id', 'authentication.clientId', 'customer_id_source', 'X-Client-Id'].forEach(function (banned) {
        check('template does not read identity from ' + banned,
            template.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '').indexOf(banned) === -1);
    });
}

// ── 3. Exclusions ────────────────────────────────────────────────────
const X_BEGIN = '// ── Exclusions (requests that are NOT metered at all) ── [shared block]';
const X_END = '// ── end exclusions ── [shared block]';
const mcpBody = sharedBody('mcp-mule-policy.yaml');
const xMain = between(mainBody, X_BEGIN, X_END);
const xMcp = between(mcpBody, X_BEGIN, X_END);
check('exclusion block present in template.xml', xMain !== null);
eq('exclusion block identical in mcp-mule-policy.yaml', xMcp, xMain);

[['template.xml', mainBody, DEFINITION], ['mcp-mule-policy.yaml', mcpBody, 'mcp-mule-policy.yaml']].forEach(function (pair) {
    const file = pair[0];
    const body = pair[1];
    const yaml = read(pair[2]);
    const code = body.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    ['exclude-status-codes', 'exclude-paths', 'status-outcomes'].forEach(function (prop) {
        check(file + ' declares property ' + prop, yaml.indexOf('  - propertyName: ' + prop + '\n') !== -1);
        check(file + ' reads configuration.' + prop, code.indexOf("configuration.'" + prop + "'") !== -1);
    });
    check(file + ' default status codes 401,403,429', code.indexOf('var defaultExcludeStatusCodes = [401, 403, 429]') !== -1);
    check(file + ' default paths /health,/ready,/metrics',
        code.indexOf('var defaultExcludePaths = ["/health", "/ready", "/metrics"]') !== -1);
    check(file + ' "none" excludes nothing', code.indexOf('lower(entries[0]) == "none"') !== -1);
    check(file + ' equal-or-prefix path match', code.indexOf('attributes.requestPath startsWith prefix') !== -1);
    check(file + ' status entries limited to 100-599', code.indexOf('entry matches /[1-5][0-9][0-9]/') !== -1);
    check(file + ' non-text config is read as blank, not coerced',
        code.indexOf('if (raw is String) raw else if (raw is Number) (raw as String) else ""') !== -1);
    eq(file + ' events array gated on isMeterable',
        (code.match(/events: if \(isMeterable\) \[/g) || []).length, 1);
    eq(file + ' exactly one events array', (code.match(/events: /g) || []).length, 1);
    {
        const gateDef = code.slice(code.indexOf(file === 'template.xml' ? 'var skipReason =' : 'var isMeterable ='), code.lastIndexOf('\n---\n'));
        check(file + ' gate covers exclusions', gateDef.indexOf('isExcluded') !== -1);
        check(file + ' gate covers a missing identity', gateDef.indexOf('hasAuthenticatedIdentity') !== -1);
        check(file + ' gate covers OPTIONS', gateDef.indexOf('isPreflight') !== -1 &&
            code.indexOf('var isPreflight = upper(requestMethod) == "OPTIONS"') !== -1);
        check(file + ' gate covers a customer id over 64 characters',
            /sizeOf\(authenticatedCustomerId\) (> 64|<= 64)/.test(gateDef));
    }
    check(file + ' never sends a placeholder customer',
        !/customerId: [^\n]*("unknown"|"anonymous"|null)/.test(code));
    eq(file + ' productType on both event shapes', (code.match(/^\s+productType: /gm) || []).length, 2);
    check(file + ' MCP_SERVER only with an agentId',
        code.indexOf('var mcpProductType = if ((agentId as String) != "") "MCP_SERVER" else productType') !== -1 &&
        code.indexOf('productType: mcpProductType,') !== -1);
    check(file + ' product type defaults to API, trimmed and upper-cased',
        code.indexOf('var productType = if (configuredProductType == "") "API" else configuredProductType') !== -1 &&
        /var configuredProductType = upper\((trim|setting)\(/.test(code));
    check(file + ' default metric is api_calls with {method} / {path} tokens',
        code.indexOf('(if (defaultMetricSetting == "") "api_calls" else defaultMetricSetting)') !== -1 ||
        code.indexOf('(if (configuredDefaultMetric == "") "api_calls" else configuredDefaultMetric)') !== -1);
    check(file + ' no route-shaped metric name by default', code.indexOf('++ " " ++ (attributes.requestPath') === -1);
    check(file + ' isExcluded is defined before the body separator',
        code.indexOf('var isExcluded = isExcludedStatus or isExcludedPath') !== -1 &&
        code.indexOf('var isExcluded = ') < code.lastIndexOf('\n---\n'));
    eq(file + ' executionStatus on both event shapes',
        (code.match(/\(executionStatus: executionStatus\) if executionStatus != null/g) || []).length, 2);
    eq(file + ' occurredAt on both event shapes', (code.match(/occurredAt: occurredAtUtc,/g) || []).length, 2);
    check(file + ' occurredAt is shifted to UTC before the literal Z',
        code.indexOf("var occurredAtUtc = (now() >> \"UTC\") as String {format: \"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'\"}") !== -1);

    // ── 4. Idempotency keys (Rule #21) ──
    const keys = code.match(/idempotencyKey: .*/g) || [];
    eq(file + ' two idempotency keys', keys.length, 2);
    check(file + ' MCP key unchanged',
        keys.indexOf('idempotencyKey: "mcp:mulesoft:" ++ (attributes.requestId default uuid()) ++ ":" ++ toolName,') !== -1);
    check(file + ' standard key unchanged',
        keys.indexOf('idempotencyKey: attributes.requestId default uuid(),') !== -1);
    check(file + ' no clock in an idempotency key', keys.every(function (k) { return k.indexOf('now()') === -1; }));
});

// ── 5. 2.2.0 merge (package template) ────────────────────────────────
{
    const code = mainBody.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    // Aliases: canonical first, alias only when the canonical one is blank.
    check('setting() prefers the canonical property',
        code.indexOf('if (canonical != "") canonical else fallback') !== -1);
    [['product-type', 'product_type'], ['default-metric', 'default_metric'],
        ['quantity-source', 'quantity_source'], ['include-metadata', 'include_metadata']].forEach(function (pair) {
        check('alias ' + pair[1] + ' is read behind ' + pair[0],
            code.indexOf('setting("' + pair[0] + '", "' + pair[1] + '")') !== -1);
        check('alias ' + pair[1] + ' is rendered into configuration',
            template.indexOf('"' + pair[1] + '": "{{{' + pair[1] + '}}}"') !== -1 &&
            template.indexOf('"' + pair[0] + '": "{{{' + pair[0] + '}}}"') !== -1);
        check('alias ' + pair[1] + ' is described as deprecated',
            new RegExp('- propertyName: ' + pair[1] + '\\n    name: ' + pair[1] + ' \\(deprecated\\)').test(definition));
    });
    // Metric naming: mapping match, then the default metric.
    check('mapping rules are KIND|value|metric separated by ";"',
        code.indexOf('(setting("metric-mappings", null) splitBy ";")') !== -1 && code.indexOf('(rule splitBy "|")') !== -1);
    check('mapping kinds are EXACT, PREFIX, CONTAINS',
        code.indexOf('["EXACT", "PREFIX", "CONTAINS"] contains upper(rule[0])') !== -1 &&
        code.indexOf('if (upper(rule[0]) == "EXACT") requestPath == rule[1]') !== -1 &&
        code.indexOf('else if (upper(rule[0]) == "PREFIX") requestPath startsWith rule[1]') !== -1 &&
        code.indexOf('else requestPath contains rule[1]))[0]') !== -1);
    check('mapping match wins over the default metric',
        code.indexOf('var metricName = if (matchedRule != null) matchedRule[2] else defaultMetric') !== -1);
    check('standard event sends the resolved metric', code.indexOf('metricName: metricName,') !== -1);
    check('MCP metric name unchanged', code.indexOf('metricName: "mcp_server.tool_invocations",') !== -1);
    check('empty or over-255 metric name is not sent',
        code.indexOf('var isMetricSendable = (sizeOf(metricName) > 0) and (sizeOf(metricName) <= 255)') !== -1 &&
        code.indexOf('else if ((not isMcpToolCall) and (not isMetricSendable)) "metric"') !== -1);
    // Skip order: one reason, first match.
    eq('skip reasons in order',
        (code.slice(code.indexOf('var skipReason ='), code.indexOf('var isMeterable')).match(/"[a-z0-9-]+"/g) || []).join(','),
        '"options","excluded","no-identity","customer-id-too-long","quantity","metric"');
    check('skipReason is only present with an empty events array',
        code.indexOf('(skipReason: skipReason) if (not isMeterable),') !== -1 &&
        code.indexOf('var isMeterable = skipReason == null') !== -1);
    check('quantity 0 is skipped', code.indexOf('else if ((not isMcpToolCall) and (quantity <= 0)) "quantity"') !== -1);
    check('standard event sends the resolved quantity', code.indexOf('quantity: quantity,') !== -1);
    check('traceparent still wins the product type',
        code.indexOf('productType: if (isAgenticApi) "AGENTIC_API" else productType,') !== -1 &&
        code.indexOf('(traceId: agenticTraceId) if isAgenticApi,') !== -1);
    eq('metadata is optional on both event shapes', (code.match(/\}\) if includeMetadata/g) || []).length, 2);
}

check('balanced brackets in the shared script', (function () {
    const stripped = mainBody.replace(/\/\/.*$/gm, '').replace(/"(\\.|[^"\\])*"/g, '""').replace(/\/[^\/\n]+\/(?=[\s)])/g, 'RE');
    const pairs = { ')': '(', ']': '[', '}': '{' };
    const stack = [];
    for (const c of stripped) {
        if ('([{'.indexOf(c) !== -1) stack.push(c);
        else if (pairs[c]) { if (stack.pop() !== pairs[c]) return false; }
    }
    return stack.length === 0;
})());

console.log('\nMuleSoft policy checks: ' + passed + ' passed, ' + failed + ' failed (DataWeave not executed)');
process.exit(failed === 0 ? 0 : 1);
