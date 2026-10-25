'use strict';
// A dependency-free test runner: test(name, fn), then report() exits non-zero
// on any failure. CI runs these with plain `node`, no npm install.

const results = { passed: 0, failed: 0 };

function test(name, fn) {
    try {
        fn();
        results.passed++;
        console.log('  ok   ' + name);
    } catch (e) {
        results.failed++;
        console.error('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e));
    }
}

function section(title) {
    console.log('\n' + title);
}

function report(label) {
    console.log(`\n${label}: ${results.passed} passed, ${results.failed} failed`);
    if (results.failed > 0) process.exitCode = 1;
    return results;
}

module.exports = { test, section, report, results };
