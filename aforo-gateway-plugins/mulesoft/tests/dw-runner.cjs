/**
 * Shared by dataweave.test.cjs and flow.test.cjs: reads the policy's
 * DataWeave scripts out of template.xml and runs them with the DataWeave CLI
 * (DW_BIN, default `dw`). See dataweave.test.cjs for how a script is wrapped.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TEMPLATE = path.join(__dirname, '..', 'aforo-metering/src/main/mule/template.xml');
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

// Runs script `name` once per case ({vars, attributes, payload}) in one CLI
// call. Returns [{ok, result} | {ok: false, error}], or throws when the CLI
// cannot run or the script does not compile.
let tmpDir = null;
let scripts = null;
function runCases(name, cases) {
    if (scripts === null) scripts = scriptsOf(fs.readFileSync(TEMPLATE, 'utf8'));
    if (!scripts[name]) throw new Error('template.xml has no script "' + name + '"');
    if (tmpDir === null) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aforo-dw-'));
    const driver = path.join(tmpDir, name + '.dwl');
    const input = path.join(tmpDir, name + '-cases.json');
    fs.writeFileSync(driver, driverOf(name, scripts[name]));
    fs.writeFileSync(input, JSON.stringify(cases));
    const run = spawnSync(DW, ['run', '-i', 'cases=' + input, '-f', driver], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error) {
        const e = new Error('cannot run the DataWeave CLI (' + DW + '): ' + run.error.message);
        e.noCli = true;
        throw e;
    }
    try {
        return JSON.parse(run.stdout);
    } catch (e) {
        throw new Error('script "' + name + '" did not run\n' + run.stdout + '\n' + run.stderr);
    }
}

module.exports = { TEMPLATE: TEMPLATE, DW: DW, scriptsOf: scriptsOf, driverOf: driverOf, runCases: runCases };
