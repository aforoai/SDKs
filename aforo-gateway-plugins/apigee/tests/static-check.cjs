'use strict';
/**
 * Static checks of both shared-flow bundles, the things Apigee only reports
 * at import or deploy time (or not at all):
 *   - every XML file is well-formed (strict parser)
 *   - the manifest lists exactly the policies in policies/ and the scripts in
 *     resources/jsc/; every Step names a listed policy, every policy is used
 *     by a Step, every policy's name is its file name
 *   - every jsc:// a policy references exists and is listed
 *   - every Step condition parses (only comparisons with a string or null)
 *   - message templates are plain {variable} references
 *   - KVM reads: organization scope, map aforo-metering-config, private.*
 *     assignTo (Apigee X encrypted KVMs), and every KVM key is documented
 *   - ServiceCallout timeouts are literal; the quota check waits 1500 ms
 *   - the two copies of aforo-billing.js are byte-identical
 *   - scripts are ES5 (Rhino): no let/const, arrows, template strings, classes
 *
 * Run: node apigee/tests/static-check.cjs   (from aforo-gateway-plugins/)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test, section, report } = require('./lib/harness.cjs');
const sim = require('./lib/apigee-sim.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUNDLES = {
    'aforo-access': path.join(ROOT, 'aforo-access', 'sharedflowbundle'),
    'aforo-metering': path.join(ROOT, 'sharedflowbundle')
};
const DOCS = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') + fs.readFileSync(path.join(ROOT, 'USER_GUIDE.md'), 'utf8');

function walk(dir, out = []) {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}

for (const [name, dir] of Object.entries(BUNDLES)) {
    section(`${name} (${path.relative(ROOT, dir)})`);
    const files = walk(dir);

    test('every file is in a known place: manifest, sharedflows/, policies/, resources/jsc/', () => {
        for (const f of files) {
            const rel = path.relative(dir, f);
            assert.ok(/^[\w-]+\.xml$/.test(rel) || /^sharedflows\/default\.xml$/.test(rel) ||
                /^policies\/\w+\.xml$/.test(rel) || /^resources\/jsc\/[\w-]+\.js$/.test(rel), rel);
        }
    });

    test('every XML file is well-formed', () => {
        for (const f of files.filter((x) => x.endsWith('.xml'))) sim.parseXml(fs.readFileSync(f, 'utf8'), f);
    });

    const bundle = sim.loadBundle(dir);

    test(`manifest is ${name}.xml and names the bundle ${name}`, () => {
        assert.strictEqual(bundle.manifestFile, `${name}.xml`);
        assert.strictEqual(bundle.manifest.name, 'SharedFlowBundle');
        assert.strictEqual(bundle.manifest.attrs.name, name);
        assert.deepStrictEqual(sim.kids(sim.kid(bundle.manifest, 'SharedFlows'), 'SharedFlow').map(sim.text), ['default']);
    });

    test('manifest <Policies> = files in policies/ = policies used by Steps', () => {
        const listed = sim.kids(sim.kid(bundle.manifest, 'Policies'), 'Policy').map(sim.text).sort();
        const onDisk = Object.keys(bundle.policies).sort();
        const used = [...new Set(bundle.steps.map((s) => s.name))].sort();
        assert.deepStrictEqual(listed, onDisk, 'manifest vs policies/');
        assert.deepStrictEqual(used, onDisk, 'Steps vs policies/');
        for (const [file, policy] of Object.entries(bundle.policies)) assert.strictEqual(policy.attrs.name, file, `${file}.xml name attribute`);
    });

    test('manifest <Resources> = files in resources/jsc/ = scripts the policies reference', () => {
        const listed = sim.kids(sim.kid(bundle.manifest, 'Resources'), 'Resource').map(sim.text).sort();
        const onDisk = Object.keys(bundle.resources).sort();
        const referenced = new Set();
        for (const p of Object.values(bundle.policies)) {
            for (const tag of ['ResourceURL', 'IncludeURL']) sim.kids(p, tag).forEach((e) => referenced.add(sim.text(e)));
        }
        assert.deepStrictEqual(listed, onDisk, 'manifest vs resources/jsc/');
        assert.deepStrictEqual([...referenced].sort(), onDisk, 'referenced vs resources/jsc/');
    });

    test('every policy type has a simulator, and Javascript policies include aforo-billing.js before a script that needs it', () => {
        for (const [file, p] of Object.entries(bundle.policies)) {
            assert.ok(sim.EXECUTORS[p.name], `${file}: ${p.name}`);
            if (p.name !== 'Javascript') continue;
            const main = bundle.resources[sim.text(sim.kid(p, 'ResourceURL'))];
            if (/\baforo[A-Z]\w*\(/.test(main.replace(/function aforo\w+/g, ''))) {
                assert.deepStrictEqual(sim.kids(p, 'IncludeURL').map(sim.text), ['jsc://aforo-billing.js'], file);
            }
        }
    });

    test('every Step condition parses', () => {
        for (const s of bundle.steps) if (s.condition) sim.parseCondition(s.condition);
    });

    test('message templates are plain {variable} references', () => {
        for (const [file, p] of Object.entries(bundle.policies)) {
            for (const tag of ['Header', 'Payload', 'URL']) {
                for (const e of sim.descendants(p, tag)) {
                    const t = sim.text(e);
                    const stripped = t.replace(sim.TEMPLATE_VAR, '');
                    assert.ok(!/[{}]/.test(stripped), `${file} <${tag}>: ${t}`);
                }
            }
        }
    });

    test('KVM reads: organization scope, aforo-metering-config, private.* assignTo, documented keys', () => {
        for (const [file, p] of Object.entries(bundle.policies)) {
            if (p.name !== 'KeyValueMapOperations') continue;
            assert.strictEqual(p.attrs.mapIdentifier, 'aforo-metering-config', file);
            assert.strictEqual(sim.text(sim.kid(p, 'Scope')), 'organization', file);
            assert.strictEqual(p.attrs.continueOnError, 'true', file);
            for (const g of sim.kids(p, 'Get')) {
                assert.ok(g.attrs.assignTo.startsWith('private.'), `${file}: ${g.attrs.assignTo}`);
                const key = sim.text(sim.kids(sim.kid(g, 'Key'), 'Parameter')[0]);
                assert.ok(DOCS.includes('`' + key), `KVM key ${key} is not documented in README/USER_GUIDE`);
            }
        }
    });

    test('ServiceCallouts: literal timeouts; continueOnError', () => {
        for (const [file, p] of Object.entries(bundle.policies)) {
            if (p.name !== 'ServiceCallout') continue;
            assert.strictEqual(p.attrs.continueOnError, 'true', file);
            for (const prop of sim.descendants(p, 'Property')) assert.ok(!/[{}]/.test(sim.text(prop)), `${file}: ${prop.attrs.name}`);
        }
    });

    test('scripts are ES5 (Rhino)', () => {
        for (const [ref, src] of Object.entries(bundle.resources)) {
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
            for (const [re, what] of [[/\blet\s/, 'let'], [/\bconst\s/, 'const'], [/=>/, 'arrow function'], [/`/, 'template string'], [/\bclass\s/, 'class']]) {
                assert.ok(!re.test(code), `${ref}: ${what}`);
            }
        }
    });
}

section('Both bundles');

test('aforo-billing.js is byte-identical in both bundles', () => {
    const a = fs.readFileSync(path.join(BUNDLES['aforo-metering'], 'resources/jsc/aforo-billing.js'));
    const b = fs.readFileSync(path.join(BUNDLES['aforo-access'], 'resources/jsc/aforo-billing.js'));
    assert.ok(a.equals(b), 'copy sharedflowbundle/resources/jsc/aforo-billing.js to aforo-access/sharedflowbundle/resources/jsc/');
});

test('flow hooks: aforo-access is a request-path flow, aforo-metering a response-path one', () => {
    const access = sim.loadBundle(BUNDLES['aforo-access']);
    const metering = sim.loadBundle(BUNDLES['aforo-metering']);
    assert.ok(/PreProxyFlowHook/.test(sim.text(sim.kid(access.manifest, 'Description'))));
    assert.ok(/PostProxyFlowHook/.test(sim.text(sim.kid(metering.manifest, 'Description'))));
    assert.ok(!Object.values(metering.policies).some((p) => p.name === 'RaiseFault'), 'metering never answers the client');
});

test('the pre-flight quota check waits at most 1500 ms', () => {
    const p = sim.loadBundle(BUNDLES['aforo-access']).policies.AforoQuotaCheck;
    assert.strictEqual(sim.text(sim.kid(p, 'Timeout')), '1500');
    const props = Object.fromEntries(sim.descendants(p, 'Property').map((x) => [x.attrs.name, sim.text(x)]));
    assert.strictEqual(props['io.timeout.millis'], '1500');
});

test('VERSION matches the README and the CHANGELOG', () => {
    const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
    assert.ok(/^\d+\.\d+\.\d+$/.test(version), version);
    assert.ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes(`**Version:** ${version}`));
    assert.ok(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').includes(`## [${version}]`));
});

test('the simulator refuses malformed XML and bare condition operands', () => {
    assert.throws(() => sim.parseXml('<a><b></a>', 't'));
    assert.throws(() => sim.parseXml('<a x="1" x="2"/>', 't'));
    assert.throws(() => sim.parseXml('<a>1 & 2</a>', 't'));
    assert.throws(() => sim.parseCondition('aforo.flag'));
    assert.throws(() => sim.parseCondition('(a = "x"'));
});

report('apigee static checks');
