/**
 * MuleSoft policy structure checks — `node mulesoft/tests/policy.test.cjs`
 * from aforo-gateway-plugins/ (node 18+, no dependencies).
 *
 * The billing logic (the DataWeave scripts) is executed by
 * dataweave.test.cjs with the DataWeave CLI. This file checks everything
 * around it that a Mule runtime would otherwise be needed for:
 *   1. the package: pom (mule-policy, 3.2.0 = VERSION, public repositories
 *      only), mule-artifact.json, the policy definition (every MC3 property,
 *      defaults, the secret marked sensitive)
 *   2. the template agrees with the definition: every property is read
 *      exactly once, as "={{name}}", and nothing else is rendered by
 *      Handlebars (no property ever reaches DataWeave source text)
 *   3. template.xml is well-formed XML and the flow is in the right order:
 *      identity, quota check, refusal without execute-next, key removal,
 *      execute-next, metering in async; every variable read is written;
 *      a delivery claims pending entries by removing them, and only then
 *      sends them
 *   4. the outbound calls: URLs, headers, timeouts, validators, targets
 *   5. the two METER BLOCK copies are identical
 *   6. the docs name every property
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sync = require('./sync-meter-block.cjs');

const DIR = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(DIR, f), 'utf8'); };
const template = read('aforo-metering/src/main/mule/template.xml');
const definition = read('aforo-metering/aforo-metering.yaml');
const pom = read('aforo-metering/pom.xml');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL: ' + name + (detail !== undefined ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function count(text, needle) {
    return text.split(needle).length - 1;
}
function between(text, a, b, from) {
    const i = text.indexOf(a, from || 0);
    if (i === -1) return null;
    const j = text.indexOf(b, i + a.length);
    return j === -1 ? null : text.slice(i + a.length, j);
}
const stripCdata = function (t) { return t.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '<![CDATA[]]>'); };
const stripComments = function (t) { return t.replace(/<!--[\s\S]*?-->/g, ''); };
const xmlOnly = stripComments(stripCdata(template));
const code = stripComments(template);

// MC3, in the order of the definition file.
const MC3 = [
    'aforo-endpoint', 'aforo-api-key', 'aforo-tenant-id', 'aforo-product-id',
    'introspect-url', 'key-header',
    'identity-cache-ttl-s', 'identity-negative-ttl-s', 'identity-stale-ttl-s', 'identity-fail-open',
    'product-type', 'default-metric', 'metric-mappings', 'quantity-header', 'agent-id', 'trace-id-header',
    'status-outcomes', 'exclude-paths', 'exclude-status-codes',
    'quota-enabled', 'quota-check-url', 'quota-timeout-ms', 'quota-fail-open',
    'pending-max-entries', 'pending-ttl-s'
];

// ── 1. Package ───────────────────────────────────────────────────────
const VERSION = read('VERSION').trim();
eq('VERSION', VERSION, '3.2.0');
check('pom packaging is mule-policy', pom.indexOf('<packaging>mule-policy</packaging>') !== -1);
eq('pom artifactId/version',
    (pom.match(/<artifactId>aforo-metering<\/artifactId>\s*<version>([^<]+)<\/version>/) || [])[1], VERSION);
check('pom groupId is the Anypoint org id property', pom.indexOf('<groupId>${anypoint.org.id}</groupId>') !== -1);
check('pom uses mule-maven-plugin as an extension',
    /<artifactId>mule-maven-plugin<\/artifactId>\s*<version>[^<]+<\/version>\s*<extensions>true<\/extensions>/.test(pom));
check('pom publishes the definition as classifier policy-definition',
    pom.indexOf('<classifier>policy-definition</classifier>') !== -1 && pom.indexOf('<packaging>yaml</packaging>') !== -1);
[['org.mule.connectors', 'mule-http-connector'], ['org.mule.connectors', 'mule-objectstore-connector'],
    ['org.mule.module', 'mule-java-module'], ['com.mulesoft.modules', 'mule-secure-configuration-property-module']].forEach(function (dep) {
    check('pom depends on ' + dep[1] + ' (mule-plugin)',
        new RegExp('<groupId>' + dep[0].replace(/\./g, '\\.') + '</groupId>\\s*<artifactId>' + dep[1] +
            '</artifactId>\\s*<version>[^<]+</version>\\s*<classifier>mule-plugin</classifier>').test(pom));
});
{
    const repos = (between(pom, '<repositories>', '</repositories>') || '') + (between(pom, '<pluginRepositories>', '</pluginRepositories>') || '');
    const urls = (repos.match(/<url>([^<]+)<\/url>/g) || []).map(function (u) { return u.replace(/<\/?url>/g, ''); });
    check('build resolves from public repositories only (no Anypoint / EE credentials)',
        urls.length > 0 && urls.every(function (u) { return u === 'https://repository.mulesoft.org/releases/'; }), urls.join(', '));
}
{
    let artifact = null;
    try { artifact = JSON.parse(read('aforo-metering/mule-artifact.json')); } catch (e) { /* reported below */ }
    check('mule-artifact.json parses and sets minMuleVersion 4.x', artifact !== null && /^4\./.test(artifact.minMuleVersion || ''));
}

// Policy definition (a small reader for this file's own regular shape).
const props = {};
const declared = [];
definition.split(/\n  - propertyName: /).slice(1).forEach(function (block) {
    const lines = block.split('\n');
    const name = lines[0].trim();
    const fields = {};
    lines.slice(1).forEach(function (l) {
        const m = l.match(/^    ([A-Za-z]+): (.*)$/);
        if (m) fields[m[1]] = m[2].trim();
    });
    declared.push(name);
    props[name] = fields;
});
eq('definition id', (definition.match(/^id: (.*)$/m) || [])[1], 'aforo-metering');
check('definition has no template block (API Manager schema)', !/^template:/m.test(definition));
check('definition supports encryption (the API key arrives encrypted when the gateway has a key)',
    /^encryptionSupported: true$/m.test(definition));
eq('definition declares exactly the MC3 properties', declared, MC3);
eq('required properties', declared.filter(function (n) { return props[n].optional === 'false'; }),
    ['aforo-endpoint', 'aforo-api-key', 'aforo-tenant-id', 'aforo-product-id']);
eq('sensitive properties', declared.filter(function (n) { return props[n].sensitive === 'true'; }), ['aforo-api-key']);
declared.forEach(function (n) {
    const p = props[n];
    check(n + ' has name, description, type, optional, sensitive, allowMultiple',
        ['name', 'description', 'type', 'optional', 'sensitive', 'allowMultiple'].every(function (k) { return p[k] !== undefined; }));
});
[['identity-cache-ttl-s', 'int', '60'], ['identity-negative-ttl-s', 'int', '10'], ['identity-stale-ttl-s', 'int', '900'],
    ['identity-fail-open', 'boolean', 'false'], ['quota-enabled', 'boolean', 'false'], ['quota-timeout-ms', 'int', '1500'],
    ['quota-fail-open', 'boolean', 'true'], ['key-header', 'string', 'x-api-key'], ['product-type', 'string', 'API'],
    ['pending-max-entries', 'int', '10000'], ['pending-ttl-s', 'int', '900']].forEach(function (t) {
    eq(t[0] + ' type/default', [props[t[0]].type, props[t[0]].defaultValue], [t[1], t[2]]);
});
eq('pending-max-entries range', [props['pending-max-entries'].minimumValue, props['pending-max-entries'].maximumValue], ['100', '100000']);
eq('pending-ttl-s range', [props['pending-ttl-s'].minimumValue, props['pending-ttl-s'].maximumValue], ['60', '86400']);

// ── 2. Template <-> definition ───────────────────────────────────────
function pascal(name) {
    return name.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
}
declared.forEach(function (n) {
    const tag = '<set-variable variableName="aforoProp' + pascal(n) + '" value="={{' + n + '}}"/>';
    eq('property ' + n + ' is read once, as an attribute value', count(template, tag), 1);
    check('the config script reads vars.aforoProp' + pascal(n), template.indexOf('vars.aforoProp' + pascal(n)) !== -1);
});
{
    const tokens = template.match(/\{\{[^}]*\}\}\}?/g) || [];
    // The pending store's size and lifetime are the only properties rendered outside a
    // set-variable: an object store's attributes cannot be expressions. Each has a default
    // for an empty property, so the rendered attribute is always a number.
    const allowed = ['{{{policyId}}}', '{{#if encrypted}}', '{{/if}}', '{{#if pending-max-entries}}', '{{#if pending-ttl-s}}', '{{else}}']
        .concat(declared.map(function (n) { return '{{' + n + '}}'; }));
    const unknown = tokens.filter(function (t) { return allowed.indexOf(t) === -1; });
    eq('only known Handlebars tokens (properties double-braced, never triple)', unknown, []);
    eq('{{#if ...}} and {{/if}} balance', count(template, '{{#if '), count(template, '{{/if}}'));
    eq('one {{#if encrypted}} block', count(template, '{{#if encrypted}}'), 1);
    check('the pending store takes its size and lifetime from the properties, with the defaults when empty',
        xmlOnly.indexOf('maxEntries="{{#if pending-max-entries}}{{pending-max-entries}}{{else}}10000{{/if}}"') !== -1 &&
        xmlOnly.indexOf('entryTtl="{{#if pending-ttl-s}}{{pending-ttl-s}}{{else}}900{{/if}}" entryTtlUnit="SECONDS"') !== -1);
    check('the config script uses the same defaults and the definition\'s ranges',
        template.indexOf('pendingMaxEntries: bounded(vars.aforoPropPendingMaxEntries, 10000, 100, 100000)') !== -1 &&
        template.indexOf('pendingTtlS: bounded(vars.aforoPropPendingTtlS, 900, 60, 86400)') !== -1);
    const cdata = template.match(/<!\[CDATA\[[\s\S]*?\]\]>/g) || [];
    check('no Handlebars inside any CDATA (DataWeave never sees a raw property)',
        cdata.every(function (c) { return c.indexOf('{{') === -1; }));
    const placeholders = (template.match(/\$\{[^}]+\}/g) || []).filter(function (m) {
        return m !== '${anypoint.platform.encryption_key}' && m !== '${encryptedPropertiesFile}';
    });
    eq('no Mule property placeholders besides the gateway encryption ones', placeholders, []);
    const propVars = (template.match(/vars\.aforoProp[A-Za-z]+/g) || []).filter(function (v, i, a) { return a.indexOf(v) === i; });
    eq('every vars.aforoProp* read is a declared property',
        propVars.filter(function (v) { return declared.map(function (n) { return 'vars.aforoProp' + pascal(n); }).indexOf(v) === -1; }), []);
}

// ── 3. XML and flow order ────────────────────────────────────────────
function wellFormed(xml) {
    let rest = xml.replace(/^<\?xml[^>]*\?>/, '');
    const stack = [];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
        if (m[0].startsWith('<!--') || m[0].startsWith('<![CDATA[')) continue;
        if (m[0] === '<') return 'stray "<" at ' + m.index;
        if (m[0] === '&') return 'unescaped "&" at ' + m.index;
        if (m[3] && /\s[\w:.-]+\s*=\s*"[^"]*</.test(m[3])) return 'raw "<" in an attribute of <' + m[2] + '>';
        if (m[1] === '/') {
            const open = stack.pop();
            if (open !== m[2]) return '</' + m[2] + '> closes <' + open + '>';
        } else if (m[4] !== '/') {
            stack.push(m[2]);
        }
    }
    return stack.length === 0 ? null : 'unclosed <' + stack.join('>, <') + '>';
}
eq('template.xml is well-formed XML', wellFormed(template), null);
eq('mule-artifact.json is JSON', (function () { try { JSON.parse(read('aforo-metering/mule-artifact.json')); return null; } catch (e) { return e.message; } })(), null);

// A targetValue next to outputMimeType="text/plain" must name its output type: without it Mule
// cannot infer one ("more than one is being used: application/java,text/plain"), the request's
// error handler swallows that, and every call to Aforo reads as "no answer" (3.0.0, live, 2026-10-27).
const targetValues = template.match(/targetValue="#\[[^"]*"/g) || [];
eq('four Aforo calls store their answer with targetValue', targetValues.length, 4);
targetValues.forEach(function (tv, i) {
    check('targetValue ' + (i + 1) + ' names its output type (output application/java ---)',
        /^targetValue="#\[output application\/java ---/.test(tv), tv);
});
check('the MCP request body read names its output type',
    template.indexOf('variableName="aforoRequestText" value="#[output application/java --- (payload.^raw') !== -1);
// The body is read only when mcp-body says so: never on a chunked or undeclared length (G-w6 review).
eq('the MCP body is read in exactly one place', count(template, 'payload.^raw'), 1);
check('the MCP body read sits behind the mcp-body decision',
    template.indexOf('// aforo-script: mcp-body') !== -1 &&
    template.indexOf('// aforo-script: mcp-body') < template.indexOf('payload.^raw') &&
    template.indexOf('<when expression="#[vars.aforoMcpBody.read == true]">') !== -1 &&
    template.indexOf('<when expression="#[vars.aforoMcpBody.read == true]">') < template.indexOf('payload.^raw'));
check('a body that is not read logs a WARN and the call is still metered',
    /MCP request body not read \(' \+\+ \(vars\.aforoMcpBody\.reason/.test(template));
// MCP detection fails open (second review): its own try, inside the
// fail-closed access-check try, so a DataWeave error never answers 503.
{
    const mcpWhen = template.indexOf("<when expression=\"#[vars.aforoCfg.productType == 'MCP_SERVER' and upper(attributes.method default '') == 'POST']\">");
    const tryOpen = template.lastIndexOf('<try>', mcpWhen);
    const ownHandler = template.indexOf('MCP tools/call detection failed, the call is billed as one tools/call', mcpWhen);
    const accessHandler = template.indexOf("access check failed, answering 503");
    check('the MCP detection has its own try, opened right before it', mcpWhen !== -1 && tryOpen !== -1 &&
        /^\s*$/.test(template.slice(tryOpen + 5, template.lastIndexOf('<choice>', mcpWhen))));
    check('its handler continues, logs at WARN and clears the body', ownHandler > mcpWhen && ownHandler < accessHandler &&
        /<on-error-continue type="ANY" logException="false">\s*<logger level="WARN" message="#\['\[aforo-metering\] MCP tools\/call detection failed/.test(template) &&
        template.indexOf('<set-variable variableName="aforoRequestText" value="#[null]"/>', ownHandler) < template.indexOf('</try>', ownHandler));
    check('the mcp-body script is inside that try', template.indexOf('// aforo-script: mcp-body') > tryOpen &&
        template.indexOf('// aforo-script: mcp-body') < ownHandler);
    check('a body that is not read logs WARN once a minute per reason, DEBUG in between',
        template.indexOf("value=\"#['warn|mcp-body|' ++ (vars.aforoMcpBody.reason default 'unknown')]\"") !== -1 &&
        /<logger level="DEBUG" message="#\['\[aforo-metering\] MCP request body not read/.test(template));
}

// A POST whose MCP body was not read bills as one tools/call, not as nothing (F8).
check('an unread MCP body bills as one tools/call with toolName unknown',
    /var unread = isMcpPost and \(not \(vars\.aforoRequestText is String\)\)/.test(template) &&
    template.indexOf('var calls = if (unread) [{toolName: "unknown", id: null}]') !== -1);
check('nothing says an unread MCP body is metered as a normal request, or not metered',
    template.indexOf('metered as a normal request') === -1 && template.indexOf('its tools/call is not metered') === -1);

const NEXT = '<http-policy:execute-next/>';
const next = template.indexOf(NEXT);
eq('exactly one execute-next', count(template, NEXT), 1);
check('policy wraps the flow: proxy > source (propagating) > execute-next',
    template.indexOf('<http-policy:proxy name="{{{policyId}}}-aforo-metering">') !== -1 &&
    template.indexOf('<http-policy:source propagateMessageTransformations="true">') !== -1 &&
    template.indexOf('<http-policy:source propagateMessageTransformations="true">') < next);
const pos = {
    config: template.indexOf('// aforo-script: config'),
    request: template.indexOf('// aforo-script: request'),
    identityLookup: template.indexOf('// aforo-script: identity-lookup'),
    introspect: template.indexOf('url="#[vars.aforoCfg.introspectUrl]"'),
    identityDecide: template.indexOf('// aforo-script: identity-decide'),
    quotaLookup: template.indexOf('// aforo-script: quota-lookup'),
    quotaCall: template.indexOf('url="#[vars.aforoCfg.quotaUrl]"'),
    quotaDecide: template.indexOf('// aforo-script: quota-decide'),
    reject: template.indexOf('<when expression="#[vars.aforoAccess.outcome == \'reject\']">'),
    strip: template.indexOf('method="removeAll(Object)"'),
    next: next,
    events: template.indexOf('// aforo-script: events'),
    backlog: template.indexOf('// aforo-script: backlog'),
    async: template.indexOf('<async maxConcurrency="16">'),
    claim: template.indexOf('// aforo-script: claim'),
    batch: template.indexOf('// aforo-script: batch'),
    delivery: template.indexOf('// aforo-script: delivery'),
    putBack: template.indexOf('// aforo-script: put-back')
};
Object.keys(pos).forEach(function (k) { check('template has ' + k, pos[k] !== -1); });
const order = ['config', 'request', 'identityLookup', 'introspect', 'identityDecide', 'quotaLookup', 'quotaCall', 'quotaDecide', 'reject', 'strip', 'next'];
check('order: config, request, identity, quota check, refusal, key removal, execute-next',
    order.every(function (k, i) { return i === 0 || pos[order[i - 1]] < pos[k]; }), order.map(function (k) { return k + '@' + pos[k]; }).join(' '));
check('the quota check runs before execute-next', pos.quotaCall < next);
{
    const meter = ['next', 'events', 'backlog', 'async', 'claim', 'batch', 'delivery', 'putBack'];
    check('order after the API: events, backlog count, async, claim, batch, delivery, put-back',
        meter.every(function (k, i) { return i === 0 || pos[meter[i - 1]] < pos[k]; }), meter.map(function (k) { return k + '@' + pos[k]; }).join(' '));
}
check('metering (events, delivery) only after execute-next',
    template.indexOf('// aforo-script: events') > next && template.indexOf('<async') > next &&
    template.indexOf('url="#[vars.aforoCfg.endpoint]"') > next);
{
    // The refusal branch: answers with HttpPolicyResponseAttributes and never calls the API or meters.
    const start = pos.reject;
    const otherwise = template.indexOf('<otherwise>', start);
    const branch = template.slice(start, otherwise);
    check('a refused call never reaches execute-next', branch.indexOf(NEXT) === -1 && next > otherwise);
    check('a refused call is never metered', branch.indexOf('<async') === -1 && branch.indexOf('<http:request') === -1);
    check('a refusal is a JSON body with HttpPolicyResponseAttributes(status, headers)',
        branch.indexOf('class: "org.mule.extension.http.api.policy.HttpPolicyResponseAttributes"') !== -1 &&
        branch.indexOf('statusCode: vars.aforoAccess.status as Number') !== -1 &&
        branch.indexOf('"Content-Type": "application/json"') !== -1 &&
        branch.indexOf('output application/json\n---\nvars.aforoAccess.body') !== -1);
}
{
    // The key header leaves the request before execute-next.
    const strip = template.slice(pos.reject, next);
    check('key removal copies the headers and removes key-header',
        strip.indexOf('constructor="CaseInsensitiveMultiMap(MultiMap)"') !== -1 &&
        strip.indexOf('<java:args>#[{arg0: vars.aforoCfg.keyHeader}]</java:args>') !== -1);
    check('key removal rebuilds HttpRequestAttributes with those headers',
        strip.indexOf('constructor="HttpRequestAttributesBuilder(HttpRequestAttributes)"') !== -1 &&
        strip.indexOf('method="headers(MultiMap)"') !== -1 && strip.indexOf('method="build()"') !== -1 &&
        strip.indexOf('<ee:set-attributes><![CDATA[%dw 2.0\noutput application/java\n---\nvars.aforoForwardAttributes]]></ee:set-attributes>') !== -1);
    check('a failed key removal never fails the call',
        /method="build\(\)"[\s\S]*?<on-error-continue type="ANY" logException="false">\s*<logger level="WARN"/.test(strip));
}
check('any failure in the access section fails closed (503)',
    /<on-error-continue type="ANY" logException="true">\s*<logger level="ERROR"[^>]*>\s*<set-variable variableName="aforoAccess" value="#\[\{outcome: 'reject', status: 503/.test(template) &&
    template.indexOf('logException="true"') < pos.reject);
check('an API error is metered then propagated unchanged',
    /<http-policy:execute-next\/>\s*<error-handler>[\s\S]*?<on-error-propagate type="ANY" logException="false">\s*<set-variable variableName="aforoFlowFailed" value="#\[true\]"\/>/.test(template));
check('request id minted once with uuid(), never from the client', code.indexOf('<set-variable variableName="aforoRequestId" value="#[uuid()]"/>') !== -1 &&
    code.indexOf('correlationId') === -1);
{
    const noComments = code.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    ['X-Client-Id', 'x-customer-id', 'X-Agent-Id', 'authentication.properties', '_meta', 'traceparent" ==', "attributes.headers.'x-aforo"].forEach(function (banned) {
        check('no identity from the client: ' + banned, noComments.indexOf(banned) === -1);
    });
}
{
    // Every variable read is written somewhere (set-variable, ee:set-variable or target).
    const written = {};
    (template.match(/(?:variableName|counterVariableName|target)="(aforo\w+)"/g) || []).forEach(function (m) { written[m.replace(/.*="|"/g, '')] = true; });
    const reads = (template.match(/vars\.(aforo\w+)/g) || []).map(function (m) { return m.slice(5); })
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
    eq('every vars.aforo* read is written', reads.filter(function (v) { return !written[v]; }), []);
}
check('object stores are per policy instance and in memory',
    (xmlOnly.match(/<os:object-store [^>]*>/g) || []).length === 3 &&
    (xmlOnly.match(/<os:object-store [^>]*>/g) || []).every(function (t) { return /name="\{\{\{policyId\}\}\}-aforo-/.test(t) && /persistent="false"/.test(t); }));
check('the identity cache is keyed by the SHA-256 of the key, never the key',
    template.indexOf('<os:retrieve key="#[vars.aforoReq.keyHash]" objectStore="{{{policyId}}}-aforo-identity"') !== -1 &&
    template.indexOf('<os:store key="#[vars.aforoReq.keyHash]" objectStore="{{{policyId}}}-aforo-identity">') !== -1 &&
    !/key="#\[vars\.aforoReq\.key\]"/.test(template));

// ── 4. Outbound calls ────────────────────────────────────────────────
const requests = xmlOnly.match(/<http:request [\s\S]*?<\/http:request>/g) || [];
const requestsFull = code.match(/<http:request [\s\S]*?<\/http:request>/g) || [];
eq('three kinds of outbound call (introspection, quota, ingest) x meter copies', requestsFull.length, 4);
requestsFull.forEach(function (r, i) {
    const label = 'outbound call ' + (i + 1);
    check(label + ' uses the policy http config, no redirects, own target',
        r.indexOf('config-ref="{{{policyId}}}-aforo-http"') !== -1 && r.indexOf('followRedirects="false"') !== -1 &&
        /target="aforo\w+"/.test(r) && (r.indexOf('targetValue="#[output application/java --- {status: attributes.statusCode, text: (payload default \'\') as String}]"') !== -1 ||
            r.indexOf('targetValue="#[output application/java --- {status: attributes.statusCode, text: (payload default \'\') as String, retryAfter: attributes.headers.\'retry-after\' default null}]"') !== -1));
    check(label + ' reads every status itself (validator 100..599)', r.indexOf('<http:success-status-code-validator values="100..599"/>') !== -1);
    check(label + ' sends its own body, never the API payload', r.indexOf('<http:body>') !== -1);
});
function headerNames(r) {
    const h = between(r, '<http:headers><![CDATA[#[{', '}]]]></http:headers>') || '';
    return (h.match(/'[^']+':/g) || []).map(function (s) { return s.slice(1, -2); });
}
{
    const intro = requestsFull.filter(function (r) { return r.indexOf('vars.aforoCfg.introspectUrl') !== -1; });
    eq('one introspection call', intro.length, 1);
    eq('introspection headers', headerNames(intro[0] || ''), ['Content-Type', 'X-API-Key']);
    check('introspection body is {key}, timeout introspectTimeoutMs (1500)',
        (intro[0] || '').indexOf('{key: vars.aforoReq.key}') !== -1 &&
        (intro[0] || '').indexOf('responseTimeout="#[vars.aforoCfg.introspectTimeoutMs]"') !== -1 &&
        template.indexOf('introspectTimeoutMs: 1500') !== -1);
    const quota = requestsFull.filter(function (r) { return r.indexOf('vars.aforoCfg.quotaUrl') !== -1; });
    eq('one quota call', quota.length, 1);
    eq('quota headers', headerNames(quota[0] || ''), ['Content-Type', 'X-API-Key', 'X-Tenant-Id']);
    check('quota body is {customerId, metricName}, timeout quota-timeout-ms',
        (quota[0] || '').indexOf('{customerId: vars.aforoAccess.quota.customerId, metricName: vars.aforoAccess.quota.metricName}') !== -1 &&
        (quota[0] || '').indexOf('responseTimeout="#[vars.aforoCfg.quotaTimeoutMs]"') !== -1);
    const ingest = requestsFull.filter(function (r) { return r.indexOf('vars.aforoCfg.endpoint') !== -1; });
    eq('ingest call in each meter copy', ingest.length, 2);
    ingest.forEach(function (r) {
        eq('ingest headers (X-API-Key only, no Bearer, no tenant)', headerNames(r), ['Content-Type', 'X-API-Key']);
        check('ingest sends the claimed batch', r.indexOf('<http:body><![CDATA[#[vars.aforoBatch.text]]]></http:body>') !== -1);
    });
}
check('delivery: 3 attempts, re-send only what is still unsent',
    count(template, '<foreach collection="#[[1, 2, 3]]" counterVariableName="aforoAttempt">') === 2 &&
    count(template, '<raise-error type="AFORO:DELIVERY_RETRY"') === 2 &&
    count(template, 'millisBetweenRetries="2000"') === 0);
check('delivery: the wait before a retry is a non-blocking until-successful timed by the delivery script',
    count(template, '<until-successful maxRetries="1" millisBetweenRetries="#[vars.aforoDelivery.retryDelayMs]">') === 2 &&
    count(template, '<raise-error type="AFORO:BACKOFF_WAIT"') === 2 &&
    code.indexOf('Thread') === -1 && code.indexOf('sleep(') === -1);
check('delivery: full-jitter backoff (500 ms base, 30 s cap) and Retry-After (60 s cap) in the script',
    template.indexOf('var BASE_MS = 500') !== -1 && template.indexOf('var MAX_BACKOFF_MS = 30000') !== -1 &&
    template.indexOf('var MAX_RETRY_AFTER_MS = 60000') !== -1 &&
    count(template, '<set-variable variableName="aforoJitter" value="#[random()]"/>') === 2);
check('delivery: per-event retryable flag is read', template.indexOf('e.retryable == true') !== -1);
check('delivery: whole-batch retry on no answer, 408, 429 and every 5xx (TRANSPORT-SPEC)',
    count(template, 'var wholeRetry = (status == 0) or (status == 408) or (status == 429) or ((status >= 500) and (status <= 599))') === 2 &&
    template.indexOf('RETRY_STATUSES') === -1);
check('delivery: no answer is caught on the ingest call only (connectivity, timeout)',
    count(template, '<on-error-continue type="HTTP:CONNECTIVITY, HTTP:TIMEOUT" logException="false">') === 2);
check('delivery is bounded: 16 at once, pending-max-entries waiting',
    count(template, '<async maxConcurrency="16">') === 2 &&
    count(template, '<when expression="#[vars.aforoCfg.pendingMaxEntries > vars.aforoBacklog.count]">') === 2 &&
    count(template, "USAGE DROPPED: the pending store is full") === 2);

// ── 4b. Claiming pending entries (G362) ──────────────────────────────
// Batching under load rests on these: a delivery sends an entry only after its own
// os:remove of that entry's key succeeded, and no key is ever written twice.
{
    const PENDING = 'objectStore="{{{policyId}}}-aforo-pending"';
    const esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    const HANDLER = '\\s*<error-handler>\\s*(?:<!--[^>]*-->\\s*)?<on-error-continue type="ANY" logException="false"/>\\s*</error-handler>\\s*</try>';
    const stores = xmlOnly.match(new RegExp('<os:store key="[^"]*" ' + esc(PENDING) + '>', 'g')) || [];
    eq('the pending store is written in two ways only: the call\'s request id, and a new key per put-back entry',
        stores.slice().sort(), [
            '<os:store key="#[\'pb-\' ++ uuid()]" ' + PENDING + '>', '<os:store key="#[\'pb-\' ++ uuid()]" ' + PENDING + '>',
            '<os:store key="#[vars.aforoReq.requestId]" ' + PENDING + '>', '<os:store key="#[vars.aforoReq.requestId]" ' + PENDING + '>'
        ]);
    eq('a call stores its events as the events script wrote them',
        count(xmlOnly, '<os:store key="#[vars.aforoReq.requestId]" ' + PENDING + '>\n' ), 2);
    const removes = xmlOnly.match(new RegExp('<os:remove key="[^"]*" ' + esc(PENDING) + '/>', 'g')) || [];
    eq('entries leave the pending store only through a claim', removes.slice().sort(), [
        '<os:remove key="#[vars.aforoOtherKey]" ' + PENDING + '/>', '<os:remove key="#[vars.aforoOtherKey]" ' + PENDING + '/>',
        '<os:remove key="#[vars.aforoReq.requestId]" ' + PENDING + '/>', '<os:remove key="#[vars.aforoReq.requestId]" ' + PENDING + '/>'
    ]);
    eq('own entry: removed first, counted as claimed only when the remove succeeded',
        (code.match(new RegExp('<try>\\s*' + esc('<os:remove key="#[vars.aforoReq.requestId]" ' + PENDING + '/>') + '\\s*' +
            esc('<set-variable variableName="aforoClaimed" value="#[[vars.aforoOwnText]]"/>') + HANDLER, 'g')) || []).length, 2);
    eq('another entry: removed first, added to the batch only when the remove succeeded',
        (template.match(new RegExp('<try>\\s*' + esc('<os:remove key="#[vars.aforoOtherKey]" ' + PENDING + '/>') + '\\s*' +
            esc('<set-variable variableName="aforoClaimed" value="#[vars.aforoClaimed ++ [vars.aforoOtherText]]"/>') + '\\s*' +
            esc('<set-variable variableName="aforoClaim" value="#[vars.aforoClaimNext]"/>') + HANDLER, 'g')) || []).length, 2);
    eq('nothing else adds to what a delivery sends', count(xmlOnly, 'variableName="aforoClaimed"'), 6);
    eq('the claimed text is read before the remove, from the same key',
        count(xmlOnly, '<os:retrieve key="#[vars.aforoReq.requestId]" ' + PENDING + ' target="aforoOwnText">') +
        count(xmlOnly, '<os:retrieve key="#[vars.aforoOtherKey]" ' + PENDING + ' target="aforoOtherText">'), 4);
    eq('the request body is built from the claimed entries only',
        count(template, 'var texts = (if (vars.aforoClaimed is Array) vars.aforoClaimed else []) filter ($ is String)'), 2);

    // Per copy: one key listing on the call path (behind the backlog script), one in the delivery.
    eq('two key listings per meter copy', count(xmlOnly, '<os:retrieve-all-keys ' + PENDING + ' target="aforoPendingKeys"/>'), 4);
    const b = sync.blocks(template);
    const copy = template.slice(b.s1, b.e1);
    const asyncAt = copy.indexOf('<async maxConcurrency="16">');
    const lists = [];
    for (let i = copy.indexOf('<os:retrieve-all-keys'); i !== -1; i = copy.indexOf('<os:retrieve-all-keys', i + 1)) lists.push(i);
    check('the call path lists keys only when the backlog script asks for it',
        lists.length === 2 && lists[0] < asyncAt &&
        /<when expression="#\[vars\.aforoBacklog\.list\]">\s*<os:retrieve-all-keys/.test(copy.slice(0, asyncAt)));
    check('the delivery lists keys only after it claimed its own entry, and walks at most 500 of them',
        lists.length === 2 && lists[1] > asyncAt &&
        copy.indexOf('<when expression="#[not isEmpty(vars.aforoClaimed)]">') > asyncAt &&
        copy.indexOf('<when expression="#[not isEmpty(vars.aforoClaimed)]">') < lists[1] &&
        copy.indexOf('if (sizeOf(ks) > 500) ks[0 to 499] else ks') > lists[1] &&
        copy.indexOf('<foreach collection="#[vars.aforoOtherKeys]">') > lists[1]);
    check('the caps are 500 events and 1,000,000 characters per request',
        template.indexOf('var MAX_EVENTS = 500') !== -1 && template.indexOf('var MAX_CHARS = 1000000') !== -1);

    // Between the first attempt and the end of the attempts the store is not touched:
    // the claimed events live in the delivery's variables.
    const attempts = copy.slice(copy.indexOf('<foreach collection="#[[1, 2, 3]]"'), copy.indexOf('<raise-error type="AFORO:DELIVERY_RETRY"'));
    check('no object store call during the attempts', attempts.length > 0 && attempts.indexOf('<os:') === -1);
    check('after each attempt the batch is what is still unsent',
        attempts.indexOf('<set-variable variableName="aforoBatch" value="#[{text: vars.aforoDelivery.retryText, counts: vars.aforoDelivery.retryCounts}]"/>') !== -1);

    // What is left after the last attempt goes back under new keys, from the error handler.
    const handler = copy.slice(copy.indexOf('<raise-error type="AFORO:DELIVERY_RETRY"'), copy.indexOf('USAGE DROPPED: the pending store is full'));
    check('undelivered events are put back by the delivery\'s error handler, for any error',
        /<error-handler>\s*(?:<!--[\s\S]*?-->\s*)?<on-error-continue type="ANY" logException="false">\s*<set-variable variableName="aforoFailReason"/.test(handler) &&
        handler.indexOf('// aforo-script: put-back') !== -1 &&
        handler.indexOf('<foreach collection="#[vars.aforoPutBack.entries]">') !== -1 &&
        handler.indexOf("<os:store key=\"#['pb-' ++ uuid()]\" " + PENDING + '>') > handler.indexOf('// aforo-script: put-back'));
    check('put-backs are bounded: 3 per event, entries of at most 50 events',
        template.indexOf('var MAX_PUT_BACKS = 3') !== -1 && template.indexOf('var CHUNK = 50') !== -1);
    check('a failed put-back is logged, never raised', handler.indexOf('USAGE LOST (') !== -1);
    check('a delivery that finds nothing to claim past pending-ttl-s warns that usage may have expired',
        copy.indexOf("<when expression=\"#[(vars.aforoNowMs - vars.aforoEndMs) >= (vars.aforoCfg.pendingTtlS * 1000)]\">") > asyncAt &&
        copy.indexOf('USAGE MAY HAVE EXPIRED') > asyncAt && copy.indexOf("key=\"#['warn|pending-expired']\"") > asyncAt);
    check('idempotency keys are minted in the events script only (Rule #21)',
        count(template, 'idempotencyKey: ') === 6 && count(template, 'idempotencyKey: 255,') === 2 &&
        count(template, 'idempotencyKey: requestId,') === 2 &&
        count(template, 'idempotencyKey: "mcp:" ++ cfg.tenantId ++ ":" ++ requestId ++ ":" ++ ((i + 1) as String) ++ ":" ++ tool,') === 2);
}
check('the transient ingest error text matches the ingestor', template.indexOf('var TRANSIENT = "The event could not be stored"') !== -1);
check('warnings are throttled to one a minute per kind', count(template, '>= 60000]">') === 7);

// ── 5. METER BLOCK copies ────────────────────────────────────────────
{
    const b = sync.blocks(template);
    const body2 = template.slice(template.indexOf('\n', b.s2) + 1, template.lastIndexOf('\n', b.e2) + 1).split('\n').slice(0, -1);
    eq('METER BLOCK copy 2 is copy 1 (run tests/sync-meter-block.cjs after editing copy 1)',
        body2.join('\n') === sync.expectedCopy2(template).join('\n'), true);
    check('METER BLOCK copy 1 is inside the API error handler, copy 2 after it',
        b.s1 > next && template.lastIndexOf('<on-error-propagate', b.s1) > next && b.s2 > template.indexOf('</on-error-propagate>', b.s1));
}

// ── 6. Docs ──────────────────────────────────────────────────────────
{
    const guide = read('USER_GUIDE.md');
    const readme = read('README.md');
    declared.forEach(function (n) {
        check('USER_GUIDE.md documents ' + n, guide.indexOf('`' + n + '`') !== -1);
    });
    ['401', '403', '429', '503', 'X-Aforo-Agent-Id', 'X-Aforo-Session-Id', 'X-Aforo-Trace-Id', 'X-Aforo-Quantity', 'Mcp-Session-Id', '60 s',
        'pending-max-entries', 'pending-ttl-s', 'restart', '500 events'].forEach(function (t) {
        check('README.md mentions ' + t, readme.indexOf(t) !== -1);
    });
    check('README names the jar this version builds', readme.indexOf('aforo-metering-' + VERSION + '-mule-policy.jar') !== -1);
    check('CHANGELOG has the ' + VERSION + ' entry', read('CHANGELOG.md').indexOf('## [' + VERSION + ']') !== -1);
    check('the user guide says what a restart loses', /restart/i.test(guide) && guide.indexOf('pending-max-entries') !== -1);
    ['USAGE NOT DELIVERED', 'USAGE DROPPED after 3 put-backs', 'USAGE DROPPED: the pending store is full', 'USAGE MAY HAVE EXPIRED', 'USAGE LOST'].forEach(function (l) {
        check('USER_GUIDE.md explains the log line ' + l, guide.indexOf(l) !== -1);
        check('the template logs ' + l, template.indexOf(l.replace('after 3 put-backs', 'after ')) !== -1);
    });
}

console.log('\nMuleSoft policy structure checks: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
