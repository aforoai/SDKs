'use strict';
/**
 * Just enough CloudFormation for the template tests, with no npm packages:
 *
 *   parse(text)                 the YAML subset these templates use (block mappings and
 *                               sequences, flow sequences, quoted and folded scalars, the
 *                               short-form intrinsic tags, full-line comments)
 *   resolve(template, params)   checks parameter constraints and Rules, evaluates Conditions,
 *                               Fn::If, Ref, Fn::Sub, Fn::GetAtt and AWS::NoValue for one set of
 *                               parameters; drops resources and outputs whose Condition is false
 *   allows(statements, action, resource, context)
 *                               IAM-style evaluation of resolved policy statements: an explicit
 *                               Deny wins, otherwise any matching Allow (wildcards * and ?,
 *                               StringEquals / StringLike conditions against `context`)
 *
 * It throws on YAML it does not understand rather than guessing.
 */

const TAGS = {
    Ref: (v) => ({ Ref: v }),
    Sub: (v) => ({ 'Fn::Sub': v }),
    GetAtt: (v) => ({ 'Fn::GetAtt': Array.isArray(v) ? v : String(v).split('.') }),
    If: (v) => ({ 'Fn::If': v }),
    Equals: (v) => ({ 'Fn::Equals': v }),
    Not: (v) => ({ 'Fn::Not': v }),
    And: (v) => ({ 'Fn::And': v }),
    Or: (v) => ({ 'Fn::Or': v }),
    Condition: (v) => ({ Condition: v }),
};

function tagged(name, value) {
    const f = TAGS[name];
    if (!f) throw new Error(`unsupported tag !${name}`);
    return f(value);
}

function unquote(s) {
    if (s.startsWith("'")) {
        if (!s.endsWith("'") || s.length < 2) throw new Error(`unterminated string ${s}`);
        return s.slice(1, -1).replace(/''/g, "'");
    }
    if (s.startsWith('"')) {
        if (!s.endsWith('"') || s.length < 2) throw new Error(`unterminated string ${s}`);
        return JSON.parse(s);
    }
    return s;
}

/** Flow value: [a, !Ref b, [c]] , !Tag x , 'quoted' , plain. */
function parseFlow(src) {
    let i = 0;
    const ws = () => { while (src[i] === ' ') i++; };
    function value() {
        ws();
        if (src[i] === '!') {
            const m = /^!(\w+)/.exec(src.slice(i));
            i += m[0].length;
            return tagged(m[1], value());
        }
        if (src[i] === '[') {
            i++;
            const out = [];
            ws();
            if (src[i] === ']') { i++; return out; }
            for (;;) {
                out.push(value());
                ws();
                if (src[i] === ',') { i++; continue; }
                if (src[i] === ']') { i++; return out; }
                throw new Error(`bad flow sequence: ${src}`);
            }
        }
        if (src[i] === "'" || src[i] === '"') {
            const q = src[i];
            let j = i + 1;
            for (;;) {
                if (j >= src.length) throw new Error(`unterminated string: ${src}`);
                if (src[j] === q) {
                    if (q === "'" && src[j + 1] === "'") { j += 2; continue; }
                    break;
                }
                if (q === '"' && src[j] === '\\') j++;
                j++;
            }
            const s = unquote(src.slice(i, j + 1));
            i = j + 1;
            return s;
        }
        let j = i;
        while (j < src.length && src[j] !== ',' && src[j] !== ']') j++;
        const s = src.slice(i, j).trim();
        i = j;
        return s;
    }
    const v = value();
    ws();
    if (i !== src.length) throw new Error(`trailing text in flow value: ${src}`);
    return v;
}

/** `key: value` / `key:` → [_, key, value]; a key may contain ':' not followed by a space. */
function splitKey(line) {
    const at = line.endsWith(':') && line.indexOf(': ') < 0 ? line.length - 1 : line.indexOf(': ');
    if (at <= 0) return null;
    const key = line.slice(0, at);
    if (/^['"]/.test(key) ? !/^('[^']*'|"[^"]*")$/.test(key) : /['"]/.test(key)) return null;
    return [line, key, line.slice(at + 1).trim()];
}

function parse(text) {
    const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''))
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    let pos = 0;
    const indentOf = (l) => l.length - l.trimStart().length;

    /** The value after `key:` or `- ` on line pos-1, with the parent's indent. */
    function inlineValue(rest, parentIndent) {
        if (rest === '') return block(parentIndent, true);
        if (rest === '>-' || rest === '>' || rest === '|' || rest === '|-') {
            const parts = [];
            while (pos < lines.length && indentOf(lines[pos]) > parentIndent) parts.push(lines[pos++].trim());
            return rest.startsWith('>') ? parts.join(' ') : parts.join('\n');
        }
        const tag = /^!(\w+)$/.exec(rest);
        if (tag) return tagged(tag[1], block(parentIndent, false));
        // Plain block scalars may contain commas and brackets; only these start flow syntax.
        return /^[!\['"]/.test(rest) ? parseFlow(rest) : rest;
    }

    /** A nested block deeper than parentIndent (a sequence may sit at parentIndent after a key). */
    function block(parentIndent, allowSameIndentSequence) {
        if (pos >= lines.length) throw new Error('unexpected end of document');
        const ind = indentOf(lines[pos]);
        const isSeq = lines[pos].trimStart().startsWith('- ') || lines[pos].trim() === '-';
        if (ind > parentIndent || (allowSameIndentSequence && isSeq && ind === parentIndent)) {
            return isSeq ? sequence(ind) : mapping(ind);
        }
        throw new Error(`expected a nested block after line ${pos}: ${lines[pos]}`);
    }

    function mapping(ind) {
        const out = {};
        while (pos < lines.length && indentOf(lines[pos]) === ind && !lines[pos].trimStart().startsWith('- ')) {
            const m = splitKey(lines[pos].trim());
            if (!m) throw new Error(`cannot parse mapping line: ${lines[pos]}`);
            pos++;
            const key = unquote(m[1].trim());
            if (key in out) throw new Error(`duplicate key ${key}`);
            out[key] = inlineValue((m[2] || '').trim(), ind);
        }
        if (pos < lines.length && indentOf(lines[pos]) > ind) throw new Error(`bad indentation: ${lines[pos]}`);
        return out;
    }

    function sequence(ind) {
        const out = [];
        while (pos < lines.length && indentOf(lines[pos]) === ind && lines[pos].trimStart().startsWith('- ')) {
            const rest = lines[pos].trimStart().slice(2).trim();
            if (!/^['"!\[]/.test(rest) && splitKey(rest)) {
                // A mapping starting on the dash line: re-read it as a mapping at ind + 2.
                lines[pos] = ' '.repeat(ind + 2) + rest;
                out.push(mapping(ind + 2));
            } else {
                pos++;
                out.push(inlineValue(rest, ind));
            }
        }
        return out;
    }

    const doc = mapping(0);
    if (pos !== lines.length) throw new Error(`unparsed line: ${lines[pos]}`);
    return doc;
}

const NO_VALUE = Symbol('AWS::NoValue');
const PSEUDO = { 'AWS::Partition': 'aws', 'AWS::Region': 'us-east-1', 'AWS::AccountId': '111122223333' };

function resolve(template, overrides) {
    const params = {};
    for (const [name, p] of Object.entries(template.Parameters || {})) {
        params[name] = name in overrides ? String(overrides[name]) : p.Default;
        if (params[name] === undefined) throw new Error(`parameter ${name} has no value`);
        if (p.AllowedValues && !p.AllowedValues.includes(params[name])) throw new Error(`${name}=${params[name]} not allowed`);
        if (p.AllowedPattern && !new RegExp(p.AllowedPattern).test(params[name])) throw new Error(`${name}=${params[name]} fails AllowedPattern`);
    }
    for (const k of Object.keys(overrides)) if (!(k in params)) throw new Error(`unknown parameter ${k}`);

    const condCache = {};
    function condition(name) {
        if (!(name in condCache)) {
            const def = (template.Conditions || {})[name];
            if (def === undefined) throw new Error(`unknown condition ${name}`);
            condCache[name] = evalCond(def);
        }
        return condCache[name];
    }
    function evalCond(node) {
        if (node.Condition) return condition(node.Condition);
        if (node['Fn::Equals']) { const [a, b] = node['Fn::Equals'].map((x) => value(x)); return a === b; }
        if (node['Fn::Not']) return !evalCond(node['Fn::Not'][0]);
        if (node['Fn::And']) return node['Fn::And'].every(evalCond);
        if (node['Fn::Or']) return node['Fn::Or'].some(evalCond);
        throw new Error(`bad condition ${JSON.stringify(node)}`);
    }

    const resources = template.Resources;
    const created = (id) => resources[id] && (!resources[id].Condition || condition(resources[id].Condition));
    const arnOf = (id) => {
        if (!created(id)) throw new Error(`reference to ${id}, which this stack does not create`);
        return `arn:aws:iam::111122223333:role/${id}`;
    };
    function ref(name, vars) {
        if (vars && name in vars) return vars[name];
        if (name === 'AWS::NoValue') return NO_VALUE;
        if (name in PSEUDO) return PSEUDO[name];
        if (name in params) return params[name];
        if (resources[name]) { if (!created(name)) throw new Error(`Ref to ${name}, not created`); return name; }
        throw new Error(`unknown Ref ${name}`);
    }
    function value(node) {
        if (Array.isArray(node)) return node.map(value).filter((v) => v !== NO_VALUE);
        if (node === null || typeof node !== 'object') return node;
        const keys = Object.keys(node);
        if (keys.length === 1) {
            const [k] = keys;
            const v = node[k];
            if (k === 'Ref') return ref(v);
            if (k === 'Fn::If') return condition(v[0]) ? value(v[1]) : value(v[2]);
            if (k === 'Fn::GetAtt') { if (v[1] !== 'Arn') throw new Error(`GetAtt ${v}`); return arnOf(v[0]); }
            if (k === 'Fn::Sub') {
                const [str, rawVars] = Array.isArray(v) ? v : [v, {}];
                const vars = {};
                for (const [n, x] of Object.entries(rawVars)) vars[n] = value(x);
                return str.replace(/\$\{([^}]+)\}/g, (_, n) => (n.endsWith('.Arn') ? arnOf(n.slice(0, -4)) : ref(n, vars)));
            }
            if (k.startsWith('Fn::')) throw new Error(`unsupported ${k}`);
        }
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            const r = value(v);
            if (r !== NO_VALUE) out[k] = r;
        }
        return out;
    }

    for (const [name, rule] of Object.entries(template.Rules || {})) {
        if (rule.RuleCondition && !evalCond(rule.RuleCondition)) continue;
        for (const a of rule.Assertions) {
            if (!evalCond(a.Assert)) throw new Error(`rule ${name}: ${a.AssertDescription}`);
        }
    }

    const out = { Resources: {}, Outputs: {} };
    for (const [id, r] of Object.entries(resources)) if (created(id)) out.Resources[id] = value(r);
    for (const [id, o] of Object.entries(template.Outputs || {})) {
        if (!o.Condition || condition(o.Condition)) out.Outputs[id] = value(o.Value);
    }
    out.condition = condition;
    return out;
}

/** Every statement of a resolved role's inline policies, Sid-tagged with its policy name. */
function roleStatements(resolved, roleId) {
    const role = resolved.Resources[roleId];
    if (!role) return [];
    return (role.Properties.Policies || []).flatMap((p) => p.PolicyDocument.Statement
        .map((s) => ({ ...s, Policy: p.PolicyName })));
}

const asList = (v) => (Array.isArray(v) ? v : [v]);
function glob(pattern, s) {
    const re = '^' + pattern.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\/]/g, '\\$&'))).join('') + '$';
    return new RegExp(re).test(s);
}
function conditionHolds(cond, context) {
    if (!cond) return true;
    return Object.entries(cond).every(([op, kv]) => Object.entries(kv).every(([key, want]) => {
        const have = context[key];
        if (have === undefined) return false;
        if (op === 'StringEquals') return asList(want).includes(have);
        if (op === 'StringLike') return asList(want).some((w) => glob(w, have));
        throw new Error(`unsupported condition operator ${op}`);
    }));
}
function matches(s, action, resource, context) {
    return asList(s.Action).some((a) => glob(a, action))
        && asList(s.Resource).some((r) => glob(r, resource))
        && conditionHolds(s.Condition, context);
}
function allows(statements, action, resource, context = {}) {
    if (statements.some((s) => s.Effect === 'Deny' && matches(s, action, resource, context))) return false;
    return statements.some((s) => s.Effect === 'Allow' && matches(s, action, resource, context));
}

module.exports = { parse, resolve, roleStatements, allows };
