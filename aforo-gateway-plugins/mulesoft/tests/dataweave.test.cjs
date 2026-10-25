/**
 * Runs the policy's DataWeave scripts with the open-source DataWeave CLI
 * (github.com/mulesoft/data-weave-cli), without a Mule runtime.
 *
 *   docker build --platform linux/amd64 -t aforo-dw-cli -f mulesoft/tests/dw-cli.Dockerfile mulesoft/tests
 *   docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src aforo-dw-cli node mulesoft/tests/dataweave.test.cjs
 * (from aforo-gateway-plugins/; or set DW_BIN to a local `dw`).
 *
 * The scripts are read out of aforo-metering/src/main/mule/template.xml, the
 * only copy: every CDATA section whose second line is
 * "// aforo-script: <name>". Each script is wrapped, unchanged, in a function
 *   fun aforoRun(vars, attributes, payload) = do { <declarations> --- <body> }
 * so one CLI run evaluates every case of tests/fixtures/<name>.json. A case:
 *   { "name", "vars", "attributes", "expect": {<path>: <value>},
 *     "absent": [<path>], "error": true }
 * laid over the file's "base" {vars, attributes} (objects merge, arrays and
 * other values replace).
 * <path> is dotted ("events.0.agentId"); "#length" after a path checks an
 * array's length and "#json" parses a JSON string (a payload or a cache
 * entry) so the path can go on into it. Only what a case names is compared.
 *
 * What this cannot show: how the Mule runtime feeds attributes (a MultiMap
 * of headers is given here as a JSON object) and anything outside the
 * scripts (object stores, HTTP calls, the listener). policy.test.cjs checks
 * the template's structure; tests/policy-contract.md is the live checklist.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..');
const TEMPLATE = path.join(DIR, 'aforo-metering/src/main/mule/template.xml');
const FIXTURES = path.join(__dirname, 'fixtures');
const DW = process.env.DW_BIN || 'dw';

function scriptsOf(xml) {
    const out = {};
    const re = /<!\[CDATA\[(%dw 2\.0\n\/\/ aforo-script: ([a-z-]+)\n[\s\S]*?)\]\]>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        if (out[m[2]] !== undefined && out[m[2]] !== m[1]) {
            throw new Error('two different copies of script ' + m[2]);
        }
        out[m[2]] = m[1];
    }
    return out;
}

// Script text -> driver text evaluating it once per case.
function driverOf(name, script) {
    const lines = script.split('\n');
    const sep = lines.indexOf('---');
    if (sep === -1) throw new Error(name + ': no top-level "---" line');
    const head = lines.slice(1, sep);
    const body = lines.slice(sep + 1);
    const imports = head.filter(function (l) { return /^import /.test(l); });
    const decls = head.filter(function (l) { return !/^import /.test(l) && !/^output /.test(l); });
    if (head.filter(function (l) { return /^output /.test(l); }).length !== 1) {
        throw new Error(name + ': expected exactly one output directive');
    }
    return ['%dw 2.0']
        .concat(imports)
        .concat(['output application/json', 'fun aforoRun(vars, attributes, payload) = do {'])
        .concat(decls.map(function (l) { return l === '' ? '' : '  ' + l; }))
        .concat(['  ---'])
        .concat(body.map(function (l) { return l === '' ? '' : '  ' + l; }))
        .concat([
            '}',
            '---',
            'cases map ((c) -> do {',
            '  var r = dw::Runtime::try(() -> write(aforoRun(c.vars default {}, c.attributes default {}, c.payload), "application/json"))',
            '  ---',
            '  if (r.success) {ok: true, result: read(r.result, "application/json")} else {ok: false, error: r.error.message default "error"}',
            '})',
        ])
        .join('\n');
}

function at(obj, p) {
    let cur = obj;
    const parts = p.split('.');
    for (let i = 0; i < parts.length; i++) {
        const k = parts[i];
        if (k === '#length') return Array.isArray(cur) ? cur.length : undefined;
        if (k === '#json') {
            try { cur = JSON.parse(cur); } catch (e) { return undefined; }
            continue;
        }
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
        cur = cur[k];
    }
    return cur;
}

// Case values are laid over the fixture's "base": objects merge key by key,
// anything else (arrays included) replaces.
function merge(base, over) {
    if (over === undefined) return base;
    if (base === null || over === null || typeof base !== 'object' || typeof over !== 'object' ||
            Array.isArray(base) || Array.isArray(over)) {
        return over;
    }
    const out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(over).forEach(function (k) { out[k] = merge(base[k], over[k]); });
    return out;
}

// Deep equality; object key order does not matter (the ingestor reads JSON).
function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') {
        const out = {};
        Object.keys(v).sort().forEach(function (k) { out[k] = canonical(v[k]); });
        return out;
    }
    return v;
}

function same(a, b) {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const xml = fs.readFileSync(TEMPLATE, 'utf8');
const scripts = scriptsOf(xml);
const fixtureFiles = fs.readdirSync(FIXTURES).filter(function (f) { return /\.json$/.test(f); }).sort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aforo-dw-'));

let passed = 0;
let failed = 0;
const tested = {};

fixtureFiles.forEach(function (file) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    const name = fixture.script;
    const script = scripts[name];
    if (!script) {
        failed++;
        console.error('FAIL ' + file + ': template.xml has no script "' + name + '"');
        return;
    }
    tested[name] = true;
    const driver = path.join(tmp, name + '.dwl');
    const input = path.join(tmp, name + '-cases.json');
    fs.writeFileSync(driver, driverOf(name, script));
    const base = fixture.base || {};
    const cases = fixture.cases.map(function (c) {
        return {
            vars: merge(base.vars || {}, c.vars),
            attributes: merge(base.attributes || {}, c.attributes),
            payload: c.payload === undefined ? null : c.payload
        };
    });
    fs.writeFileSync(input, JSON.stringify(cases));
    const run = spawnSync(DW, ['run', '-i', 'cases=' + input, '-f', driver], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error) {
        console.error('cannot run the DataWeave CLI (' + DW + '): ' + run.error.message);
        process.exit(2);
    }
    let results;
    try {
        results = JSON.parse(run.stdout);
    } catch (e) {
        failed++;
        console.error('FAIL ' + file + ': the script did not run\n' + run.stdout + '\n' + run.stderr);
        return;
    }
    fixture.cases.forEach(function (c, i) {
        const r = results[i];
        const label = name + ' / ' + c.name;
        const problems = [];
        if (c.error) {
            if (r.ok) problems.push('expected an error, got ' + JSON.stringify(r.result));
        } else if (!r.ok) {
            problems.push('script error: ' + r.error);
        } else {
            Object.keys(c.expect || {}).forEach(function (p) {
                const actual = at(r.result, p);
                if (!same(actual, c.expect[p])) {
                    problems.push(p + ': expected ' + JSON.stringify(c.expect[p]) + ', got ' + JSON.stringify(actual));
                }
            });
            (c.absent || []).forEach(function (p) {
                if (at(r.result, p) !== undefined) problems.push(p + ' should be absent, got ' + JSON.stringify(at(r.result, p)));
            });
        }
        if (problems.length === 0) {
            passed++;
        } else {
            failed++;
            console.error('FAIL ' + label + '\n    ' + problems.join('\n    '));
            if (process.env.DW_DEBUG) console.error(JSON.stringify(r, null, 2));
        }
    });
});

Object.keys(scripts).forEach(function (name) {
    if (!tested[name]) {
        failed++;
        console.error('FAIL script "' + name + '" has no fixture file');
    }
});

console.log('\nMuleSoft DataWeave scripts: ' + passed + ' passed, ' + failed + ' failed (' +
    Object.keys(scripts).length + ' scripts, ' + fixtureFiles.length + ' fixture files)');
process.exit(failed === 0 ? 0 : 1);
