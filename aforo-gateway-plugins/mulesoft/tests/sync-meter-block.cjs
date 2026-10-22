/**
 * template.xml meters a call in two places: after execute-next, and in the
 * on-error-propagate of the try around it (an API that fails still sends
 * its error response, and that response is metered too). Mule policies
 * offer no shared sub-flow, so the block exists twice. Edit copy 1, then run
 *   node mulesoft/tests/sync-meter-block.cjs
 * to rewrite copy 2 from it (re-indented). policy.test.cjs fails when the
 * two copies differ.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'aforo-metering/src/main/mule/template.xml');
const START1 = '<!-- >>> METER BLOCK (copy 1 of 2; tests/policy.test.cjs keeps the copies identical) -->';
const START2 = '<!-- >>> METER BLOCK (copy 2 of 2) -->';
const END = '<!-- <<< METER BLOCK -->';

function indentOf(text, marker) {
    const at = text.indexOf(marker);
    const lineStart = text.lastIndexOf('\n', at) + 1;
    return at - lineStart;
}

// Lines of the block, re-indented by delta; DataWeave inside CDATA is left as is.
function reindent(lines, delta) {
    let inCdata = false;
    return lines.map(function (line) {
        const startedInside = inCdata;
        let rest = line;
        for (;;) {
            if (!inCdata) {
                const open = rest.indexOf('<![CDATA[');
                if (open === -1) break;
                inCdata = true;
                rest = rest.slice(open + 9);
            } else {
                const close = rest.indexOf(']]>');
                if (close === -1) break;
                inCdata = false;
                rest = rest.slice(close + 3);
            }
        }
        if (startedInside || line.trim() === '') return line;
        if (delta < 0) {
            const strip = Math.min(-delta, line.length - line.trimStart().length);
            return line.slice(strip);
        }
        return ' '.repeat(delta) + line;
    });
}

function blocks(text) {
    const s1 = text.indexOf(START1);
    const e1 = text.indexOf(END, s1);
    const s2 = text.indexOf(START2);
    const e2 = text.indexOf(END, s2);
    if (s1 === -1 || e1 === -1 || s2 === -1 || e2 === -1 || !(e1 < s2)) {
        throw new Error('METER BLOCK markers not found in order');
    }
    return { s1: s1, e1: e1, s2: s2, e2: e2 };
}

function copy1Lines(text) {
    const b = blocks(text);
    const body = text.slice(text.indexOf('\n', b.s1) + 1, text.lastIndexOf('\n', b.e1) + 1);
    return body.split('\n').slice(0, -1);
}

function expectedCopy2(text) {
    const delta = indentOf(text, START2) - indentOf(text, START1);
    return reindent(copy1Lines(text), delta);
}

function sync(text) {
    const b = blocks(text);
    const head = text.slice(0, text.indexOf('\n', b.s2) + 1);
    const tail = text.slice(text.lastIndexOf('\n', b.e2) + 1);
    return head + expectedCopy2(text).join('\n') + '\n' + tail;
}

module.exports = { blocks: blocks, copy1Lines: copy1Lines, expectedCopy2: expectedCopy2, START1: START1, START2: START2, END: END };

if (require.main === module) {
    const text = fs.readFileSync(TEMPLATE, 'utf8');
    const out = sync(text);
    if (out === text) {
        console.log('METER BLOCK copies already identical');
    } else {
        fs.writeFileSync(TEMPLATE, out);
        console.log('METER BLOCK copy 2 rewritten from copy 1');
    }
}
