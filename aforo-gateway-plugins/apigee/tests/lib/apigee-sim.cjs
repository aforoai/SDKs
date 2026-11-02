'use strict';
/**
 * A small model of the Apigee runtime, just large enough to run the two Aforo
 * shared flows end to end in Node: it reads the bundle XML, evaluates each
 * Step's Condition, and executes the policy types the bundles use
 * (KeyValueMapOperations Get, VerifyAPIKey, VerifyJWT, Javascript,
 * AssignMessage, LookupCache, PopulateCache, ServiceCallout, PublishMessage,
 * RaiseFault).
 *
 * It is a model, not Apigee. It checks that the flows are wired together
 * correctly (variable names, conditions, which step answers what) and that
 * the scripts behave; it cannot prove how a live Apigee X org treats them.
 * Where Apigee's behaviour is modelled from its documentation, the comment
 * says so.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

// ── XML ──────────────────────────────────────────────────────────────────
// A strict, minimal parser: elements, attributes, text, comments, the XML
// declaration. It throws on anything not well-formed (mismatched or unclosed
// tags, duplicate attributes, a bare '<' or '&' in text).

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s, where) {
    return s.replace(/&([^;\s]*);?/g, (m, name) => {
        if (!m.endsWith(';')) throw new Error(`bare '&' in ${where}`);
        if (ENTITIES[name] !== undefined) return ENTITIES[name];
        if (/^#\d+$/.test(name)) return String.fromCharCode(parseInt(name.slice(1), 10));
        if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCharCode(parseInt(name.slice(2), 16));
        throw new Error(`unknown entity &${name}; in ${where}`);
    });
}

function parseXml(src, file) {
    let i = 0;
    const where = () => `${file || 'xml'} at offset ${i}`;
    const root = { name: '#document', attrs: {}, children: [] };
    const stack = [root];
    while (i < src.length) {
        if (src.startsWith('<?', i)) {
            const end = src.indexOf('?>', i);
            if (end < 0) throw new Error(`unclosed <? in ${where()}`);
            i = end + 2;
        } else if (src.startsWith('<!--', i)) {
            const end = src.indexOf('-->', i + 4);
            if (end < 0) throw new Error(`unclosed comment in ${where()}`);
            if (src.slice(i + 4, end).includes('--')) throw new Error(`'--' inside a comment in ${where()}`);
            i = end + 3;
        } else if (src.startsWith('<![CDATA[', i)) {
            const end = src.indexOf(']]>', i);
            if (end < 0) throw new Error(`unclosed CDATA in ${where()}`);
            stack[stack.length - 1].children.push({ text: src.slice(i + 9, end) });
            i = end + 3;
        } else if (src.startsWith('</', i)) {
            const end = src.indexOf('>', i);
            const name = src.slice(i + 2, end).trim();
            const open = stack.pop();
            if (!open || open.name !== name) throw new Error(`</${name}> closes <${open && open.name}> in ${where()}`);
            i = end + 1;
        } else if (src[i] === '<') {
            const m = /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(src.slice(i));
            if (!m) throw new Error(`malformed tag in ${where()}`);
            const el = { name: m[1], attrs: {}, children: [] };
            const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
            let a;
            while ((a = re.exec(m[2]))) {
                if (Object.prototype.hasOwnProperty.call(el.attrs, a[1])) throw new Error(`duplicate attribute ${a[1]} in ${where()}`);
                el.attrs[a[1]] = decodeEntities(a[3] !== undefined ? a[3] : a[4], where());
            }
            stack[stack.length - 1].children.push(el);
            if (!m[3]) stack.push(el);
            i += m[0].length;
        } else {
            const end = src.indexOf('<', i);
            const raw = src.slice(i, end < 0 ? src.length : end);
            if (stack.length === 1 && raw.trim() !== '') throw new Error(`text outside the root element in ${where()}`);
            stack[stack.length - 1].children.push({ text: decodeEntities(raw, where()) });
            i = end < 0 ? src.length : end;
        }
    }
    if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1].name}> in ${file}`);
    const elements = root.children.filter((c) => c.name);
    if (elements.length !== 1) throw new Error(`${file}: expected one root element, found ${elements.length}`);
    return elements[0];
}

const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0];
const text = (el) => (el ? el.children.filter((c) => c.text !== undefined).map((c) => c.text).join('').trim() : '');
const descendants = (el, name, out = []) => {
    for (const c of (el && el.children) || []) {
        if (!c.name) continue;
        if (c.name === name) out.push(c);
        descendants(c, name, out);
    }
    return out;
};

// ── Conditions ───────────────────────────────────────────────────────────
// The subset of Apigee's condition language the bundles use: comparisons
// (=, ==, !=, :=) of a variable with a quoted string or null, joined with
// and / or / not and parentheses. A bare operand is refused, so a typo
// cannot silently evaluate to false.

function tokenize(cond) {
    const out = [];
    const re = /\s*(?:(\()|(\))|("(?:[^"\\]|\\.)*")|(!=|==|:=|=)|(&&|\|\|)|([A-Za-z_][\w.\-]*)|(!))/y;
    let m;
    let pos = 0;
    while (pos < cond.length) {
        re.lastIndex = pos;
        m = re.exec(cond);
        if (!m || m[0] === '') {
            if (/^\s*$/.test(cond.slice(pos))) break;
            throw new Error(`cannot parse condition at: ${cond.slice(pos)}`);
        }
        pos = re.lastIndex;
        if (m[1]) out.push({ t: '(' });
        else if (m[2]) out.push({ t: ')' });
        else if (m[3]) out.push({ t: 'str', v: JSON.parse(m[3]) });
        else if (m[4]) out.push({ t: 'op', v: m[4] === '==' ? '=' : m[4] });
        else if (m[5]) out.push({ t: m[5] === '&&' ? 'and' : 'or' });
        else if (m[7]) out.push({ t: 'not' });
        else {
            const w = m[6];
            const lw = w.toLowerCase();
            if (lw === 'and' || lw === 'or' || lw === 'not') out.push({ t: lw });
            else if (lw === 'null') out.push({ t: 'null' });
            else out.push({ t: 'var', v: w });
        }
    }
    return out;
}

function parseCondition(cond) {
    const toks = tokenize(cond);
    let p = 0;
    const peek = () => toks[p];
    const take = (t) => {
        const x = toks[p];
        if (!x || (t && x.t !== t)) throw new Error(`condition "${cond}": expected ${t}, got ${x ? x.t : 'end'}`);
        p++;
        return x;
    };
    function orExpr() {
        let left = andExpr();
        while (peek() && peek().t === 'or') { take(); const r = andExpr(); const l = left; left = (g) => l(g) || r(g); }
        return left;
    }
    function andExpr() {
        let left = unary();
        while (peek() && peek().t === 'and') { take(); const r = unary(); const l = left; left = (g) => l(g) && r(g); }
        return left;
    }
    function unary() {
        if (peek() && peek().t === 'not') { take(); const e = unary(); return (g) => !e(g); }
        if (peek() && peek().t === '(') { take('('); const e = orExpr(); take(')'); return e; }
        const lhs = take('var').v;
        const op = take('op').v;
        const rhs = take();
        if (rhs.t !== 'str' && rhs.t !== 'null') throw new Error(`condition "${cond}": compare ${lhs} with a string or null`);
        return (g) => {
            const v = g(lhs);
            let eq;
            if (rhs.t === 'null') eq = v === null || v === undefined;
            else if (v === null || v === undefined) eq = false;
            else if (op === ':=') eq = String(v).toLowerCase() === rhs.v.toLowerCase();
            else eq = String(v) === rhs.v;
            return op === '!=' ? !eq : eq;
        };
    }
    const fn = orExpr();
    if (p !== toks.length) throw new Error(`condition "${cond}": unexpected ${toks[p].t}`);
    return fn;
}

// ── Message templates: {variable} only ───────────────────────────────────
const TEMPLATE_VAR = /\{([A-Za-z_][\w.\-]*)\}/g;
function renderTemplate(tpl, get) {
    return tpl.replace(TEMPLATE_VAR, (m, name) => {
        const v = get(name);
        return v === null || v === undefined ? '' : String(v);
    });
}

// ── Bundles ──────────────────────────────────────────────────────────────

function loadBundle(dir) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml'));
    if (files.length !== 1) throw new Error(`${dir}: expected one bundle manifest, found ${files.join(', ')}`);
    const manifest = parseXml(fs.readFileSync(path.join(dir, files[0]), 'utf8'), files[0]);
    const flow = parseXml(fs.readFileSync(path.join(dir, 'sharedflows', 'default.xml'), 'utf8'), 'default.xml');
    const policies = {};
    for (const f of fs.readdirSync(path.join(dir, 'policies'))) {
        policies[f.replace(/\.xml$/, '')] = parseXml(fs.readFileSync(path.join(dir, 'policies', f), 'utf8'), f);
    }
    const resources = {};
    const jsc = path.join(dir, 'resources', 'jsc');
    for (const f of fs.existsSync(jsc) ? fs.readdirSync(jsc) : []) {
        resources['jsc://' + f] = fs.readFileSync(path.join(jsc, f), 'utf8');
    }
    const steps = kids(flow, 'Step').map((s) => {
        const c = text(kid(s, 'Condition'));
        return { name: text(kid(s, 'Name')), condition: c, test: c ? parseCondition(c) : () => true };
    });
    return { dir, manifestFile: files[0], manifest, flow, steps, policies, resources };
}

// ── The runtime ──────────────────────────────────────────────────────────

class Fault extends Error {
    constructor(status, body, headers, code) {
        super(code || `fault ${status}`);
        this.status = status;
        this.body = body;
        this.headers = headers || {};
        this.code = code;
    }
}

const sha256 = () => {
    const h = nodeCrypto.createHash('sha256');
    return { update: (s) => { h.update(String(s)); }, digest: () => h.digest('hex') };
};

/**
 * env: { kvm: {key: value}, keys: {apiKey: {app:{}, developer:{}, products:[name], proxies?:[proxy]}},
 *        http: (req) => {status, body, headers} | {error} | {timeoutMs}, jwt: (token) => claims|null,
 *        cache: Map, clock: {now} }
 */
class Message {
    constructor(env, vars) {
        this.env = env;
        this.vars = Object.assign({}, vars);
        this.prints = [];
        this.callouts = [];
        this.trace = [];
    }
    get(name) { return Object.prototype.hasOwnProperty.call(this.vars, name) ? this.vars[name] : null; }
    set(name, value) { this.vars[name] = value; }
}

function runJs(msg, policy, bundle) {
    const sources = kids(policy, 'IncludeURL').map((e) => text(e)).concat([text(kid(policy, 'ResourceURL'))]);
    const props = {};
    for (const p of descendants(kid(policy, 'Properties'), 'Property')) props[p.attrs.name] = text(p);
    const sandbox = {
        context: {
            getVariable: (n) => msg.get(n),
            setVariable: (n, v) => msg.set(n, v)
        },
        print: (s) => msg.prints.push(String(s)),
        properties: props,
        crypto: { getSHA256: sha256 }
    };
    vm.createContext(sandbox);
    const code = sources.map((s) => {
        if (bundle.resources[s] === undefined) throw new Error(`${policy.attrs.name}: ${s} is not in the bundle`);
        return bundle.resources[s];
    }).join('\n;\n');
    vm.runInContext(code, sandbox, { filename: policy.attrs.name, timeout: 2000 });
}

function runKvm(msg, policy) {
    if (policy.attrs.mapIdentifier !== 'aforo-metering-config') throw new Error('unexpected KVM');
    for (const g of kids(policy, 'Get')) {
        const parts = [];
        let unresolved = false;
        for (const p of kids(kid(g, 'Key'), 'Parameter')) {
            if (p.attrs.ref) {
                const v = msg.get(p.attrs.ref);
                if (v === null || v === undefined) unresolved = true;
                parts.push(v === null || v === undefined ? '' : String(v));
            } else {
                parts.push(text(p));
            }
        }
        const key = parts.join('__');  // Apigee: "joined with a double underscore"
        const kvm = msg.env.kvm || {};
        if (!unresolved && Object.prototype.hasOwnProperty.call(kvm, key)) msg.set(g.attrs.assignTo, kvm[key]);
    }
}

function runVerifyApiKey(msg, policy) {
    const name = policy.attrs.name;
    const key = msg.get(kid(policy, 'APIKey').attrs.ref);
    const fail = (code) => {
        msg.set(`verifyapikey.${name}.failed`, 'true');
        throw new Fault(401, JSON.stringify({ fault: { faultstring: code, detail: { errorcode: code } } }), {}, code);
    };
    if (key === null || key === undefined || key === '') fail('oauth.v2.FailedToResolveAPIKey');
    const entry = (msg.env.keys || {})[key];
    if (!entry) fail('oauth.v2.InvalidApiKey');
    const proxy = msg.get('apiproxy.name');
    const productProxies = msg.env.productProxies || {};
    const product = (entry.products || []).find((p) => (productProxies[p] || [proxy]).includes(proxy));
    if (!product) fail('oauth.v2.InvalidApiKeyForGivenResource');
    const pre = `verifyapikey.${name}.`;
    msg.set(pre + 'failed', 'false');
    msg.set(pre + 'apiproduct.name', product);
    msg.set('apiproduct.name', product);
    msg.set(pre + 'app.name', entry.appName || 'app');
    msg.set('developer.app.name', entry.appName || 'app');
    msg.set(pre + 'developer.email', entry.email || 'dev@example.com');
    for (const [k, v] of Object.entries(entry.app || {})) {
        msg.set(pre + 'app.' + k, v);
        msg.set(pre + k, v);
    }
    for (const [k, v] of Object.entries(entry.developer || {})) msg.set(pre + 'developer.' + k, v);
}

function runVerifyJwt(msg, policy) {
    const name = policy.attrs.name;
    const auth = msg.get('request.header.authorization') || '';
    const token = /^Bearer\s+(.+)$/i.exec(auth);
    const claims = token && msg.env.jwt ? msg.env.jwt(token[1], {
        jwksUri: msg.get(kid(kid(policy, 'PublicKey'), 'JWKS').attrs.uriRef),
        issuer: msg.get(kid(policy, 'Issuer').attrs.ref)
    }) : null;
    if (!claims) throw new Fault(401, '{"fault":"steps.jwt.InvalidToken"}', {}, 'steps.jwt.InvalidToken');
    for (const [k, v] of Object.entries(claims)) msg.set(`jwt.${name}.decoded.claim.${k}`, v);
}

function runAssignMessage(msg, policy) {
    for (const av of kids(policy, 'AssignVariable')) {
        const nameVar = text(kid(av, 'Name'));
        const ref = kid(av, 'Ref');
        const val = kid(av, 'Value');
        if (ref) {
            const v = msg.get(text(ref));
            if (v !== null && v !== undefined) msg.set(nameVar, v);
            else if (val) msg.set(nameVar, text(val));
        } else if (val) {
            msg.set(nameVar, text(val));
        }
    }
    const assignTo = kid(policy, 'AssignTo');
    const target = assignTo ? assignTo.attrs.type : 'request';
    // <Remove>: header names are case-insensitive, query parameter names are not.
    const remove = kid(policy, 'Remove');
    for (const h of descendants(kid(remove, 'Headers'), 'Header')) {
        const prefix = `${target}.header.`;
        for (const n of Object.keys(msg.vars)) {
            if (n.toLowerCase() === (prefix + h.attrs.name).toLowerCase()) delete msg.vars[n];
        }
    }
    for (const q of descendants(kid(remove, 'QueryParams'), 'QueryParam')) {
        delete msg.vars[`${target}.queryparam.${q.attrs.name}`];
    }
    for (const h of descendants(kid(policy, 'Set'), 'Header')) {
        msg.set(`${target}.header.${h.attrs.name}`, renderTemplate(text(h), (n) => msg.get(n)));
    }
}

function cacheKey(msg, policy) {
    const ck = kid(policy, 'CacheKey');
    const parts = [text(kid(ck, 'Prefix'))];
    for (const f of kids(ck, 'KeyFragment')) parts.push(f.attrs.ref ? String(msg.get(f.attrs.ref)) : text(f));
    return parts.join('__');
}

function runLookupCache(msg, policy) {
    const key = cacheKey(msg, policy);
    const hit = msg.env.cache.get(key);
    const live = hit && hit.expires > msg.env.clock.now;
    msg.set(`lookupcache.${policy.attrs.name}.cachehit`, live ? 'true' : 'false');
    if (live) msg.set(text(kid(policy, 'AssignTo')), hit.value);
}

function runPopulateCache(msg, policy) {
    const t = kid(kid(policy, 'ExpirySettings'), 'TimeoutInSeconds');
    const ref = t.attrs.ref && msg.get(t.attrs.ref);
    const ttl = parseInt(ref !== null && ref !== undefined && ref !== '' ? ref : text(t), 10);
    msg.env.cache.set(cacheKey(msg, policy), {
        value: msg.get(text(kid(policy, 'Source'))),
        expires: msg.env.clock.now + ttl * 1000
    });
}

function inSuccessCodes(status, spec) {
    return spec.split(',').map((s) => s.trim().toLowerCase()).some((c) =>
        /^\dxx$/.test(c) ? String(status)[0] === c[0] : String(status) === c);
}

function runServiceCallout(msg, policy) {
    const name = policy.attrs.name;
    const req = kid(policy, 'Request');
    const set = kid(req, 'Set');
    const get = (n) => msg.get(n);
    const headers = {};
    for (const h of descendants(kid(set, 'Headers'), 'Header')) headers[h.attrs.name] = renderTemplate(text(h), get);
    const conn = kid(policy, 'HTTPTargetConnection');
    const props = {};
    for (const p of descendants(kid(conn, 'Properties'), 'Property')) props[p.attrs.name] = text(p);
    const request = {
        policy: name,
        url: renderTemplate(text(kid(conn, 'URL')), get),
        method: text(kid(set, 'Verb')) || 'GET',
        headers,
        body: renderTemplate(text(kid(set, 'Payload')), get),
        waits: !!kid(policy, 'Response')
    };
    msg.callouts.push(request);
    const res = msg.env.http(request) || { error: 'no handler' };
    const responseVar = text(kid(policy, 'Response'));
    if (!responseVar) return;  // fire and forget: Apigee does not wait for or expose the answer
    const timeout = Math.min(
        parseInt(text(kid(policy, 'Timeout')) || '55000', 10),
        parseInt(props['io.timeout.millis'] || '55000', 10));
    msg.env.clock.now += Math.min(res.latencyMs || 5, timeout);
    if (res.error || (res.timeoutMs !== undefined && res.timeoutMs >= timeout)) {
        msg.set(`servicecallout.${name}.failed`, 'true');
        if (policy.attrs.continueOnError !== 'true') throw new Fault(500, 'callout failed', {}, 'steps.servicecallout.ExecutionFailed');
        return;
    }
    msg.set(`${responseVar}.status.code`, String(res.status));
    msg.set(`${responseVar}.content`, res.body === undefined ? '' : String(res.body));
    for (const [k, v] of Object.entries(res.headers || {})) msg.set(`${responseVar}.header.${k}`, v);
    const ok = inSuccessCodes(res.status, props['success.codes'] || '1xx,2xx,3xx');
    msg.set(`servicecallout.${name}.failed`, ok ? 'false' : 'true');
    if (!ok && policy.attrs.continueOnError !== 'true') throw new Fault(500, 'callout failed', {}, 'steps.servicecallout.ResponseCodeOutOfRange');
}

// PublishMessage (Apigee X/hybrid): publishes the rendered <Source> to the
// rendered <CloudPubSub><Topic>. env.pubsub(req) answers {ok:true} or
// {error}. Modelled from the policy reference: a failed publish raises a
// fault, which continueOnError turns into a continue.
function runPublishMessage(msg, policy) {
    const get = (n) => msg.get(n);
    const request = {
        policy: policy.attrs.name,
        topic: renderTemplate(text(kid(kid(policy, 'CloudPubSub'), 'Topic')), get),
        data: renderTemplate(text(kid(policy, 'Source')), get)
    };
    msg.publishes = msg.publishes || [];
    msg.publishes.push(request);
    const res = msg.env.pubsub ? msg.env.pubsub(request) : { error: 'no Pub/Sub handler' };
    if (!res || res.error) {
        if (policy.attrs.continueOnError !== 'true') throw new Fault(500, 'publish failed', {}, 'steps.publishmessage.PublishFailed');
        msg.prints.push(`[sim] ${policy.attrs.name} publish failed: ${(res && res.error) || 'no answer'}`);
    }
}

function runRaiseFault(msg, policy) {
    const set = kid(kid(policy, 'FaultResponse'), 'Set');
    const get = (n) => msg.get(n);
    const headers = {};
    for (const h of descendants(kid(set, 'Headers'), 'Header')) headers[h.attrs.name] = renderTemplate(text(h), get);
    throw new Fault(parseInt(text(kid(set, 'StatusCode')), 10), renderTemplate(text(kid(set, 'Payload')), get),
        headers, 'RaiseFault ' + policy.attrs.name);
}

const EXECUTORS = {
    Javascript: runJs,
    KeyValueMapOperations: runKvm,
    VerifyAPIKey: runVerifyApiKey,
    VerifyJWT: runVerifyJwt,
    AssignMessage: runAssignMessage,
    LookupCache: runLookupCache,
    PopulateCache: runPopulateCache,
    ServiceCallout: runServiceCallout,
    PublishMessage: runPublishMessage,
    RaiseFault: runRaiseFault
};

/** Runs a shared flow on msg. Returns null, or the Fault that ended it. */
function runFlow(bundle, msg) {
    for (const step of bundle.steps) {
        if (!step.test((n) => msg.get(n))) continue;
        const policy = bundle.policies[step.name];
        if (!policy) throw new Error(`step ${step.name} has no policy`);
        const exec = EXECUTORS[policy.name];
        if (!exec) throw new Error(`no simulator for ${policy.name}`);
        msg.trace.push(step.name);
        try {
            exec(msg, policy, bundle);
        } catch (e) {
            if (e instanceof Fault) return e;
            if (policy.attrs.continueOnError === 'true') {
                msg.prints.push(`[sim] ${step.name} failed (continueOnError): ${e.message}`);
                continue;
            }
            throw e;
        }
    }
    return null;
}

module.exports = {
    parseXml, kids, kid, text, descendants, parseCondition, tokenize, TEMPLATE_VAR,
    loadBundle, Message, runFlow, Fault, EXECUTORS
};
