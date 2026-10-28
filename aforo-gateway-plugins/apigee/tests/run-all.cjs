'use strict';
// Runs every Apigee test file; exits non-zero if any fails.
// Run: node apigee/tests/run-all.cjs   (Node 20+, no npm install)
// The Pub/Sub forwarder tests start aforo-metering-sdks/mock-ingestor; set
// AFORO_MOCK_INGESTOR when that checkout is not next to this repo.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let failed = 0;
for (const f of ['static-check.cjs', 'unit-tests.cjs', 'flow-tests.cjs']) {
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}
const fwdTests = path.join(__dirname, '..', 'pubsub-forwarder', 'tests');
const fwdFiles = fs.readdirSync(fwdTests).filter((f) => f.endsWith('.test.js')).map((f) => path.join(fwdTests, f));
const fwd = spawnSync(process.execPath, ['--test', '--test-timeout=60000', '--test-reporter=dot'].concat(fwdFiles), { stdio: 'inherit' });
if (fwd.status !== 0) failed++;
else console.log(`apigee pubsub-forwarder tests: ${fwdFiles.length} files passed`);
if (failed) {
    console.error(`\n${failed} Apigee test file(s) failed`);
    process.exit(1);
}
console.log('\nAll Apigee tests passed');
