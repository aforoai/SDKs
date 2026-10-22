'use strict';
// Runs every Apigee test file; exits non-zero if any fails.
// Run: node apigee/tests/run-all.cjs   (Node 18+, no dependencies)
const { spawnSync } = require('child_process');
const path = require('path');

let failed = 0;
for (const f of ['static-check.cjs', 'unit-tests.cjs', 'flow-tests.cjs']) {
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}
if (failed) {
    console.error(`\n${failed} Apigee test file(s) failed`);
    process.exit(1);
}
console.log('\nAll Apigee tests passed');
