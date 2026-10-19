"use strict";

/**
 * node:test wrapper around the compiled checked-memory harness (RUN-003).
 *
 * The harness compiles src/runtime/src/ppcx_mem.c together with a generated
 * driver that exercises the region map through the real guest accessors:
 * raw mode without a model, boundary/unaligned/host accesses inside regions,
 * nine illegal accesses (each in its own process; exit code 9 and the exact
 * diagnostic line), the fault hook and run-to-run determinism. It is skipped
 * with a visible message when no C compiler is available; `node
 * tests/mem/run.js` performs the same run from the CLI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { runMem } = require("./run.js");

test("checked memory: the compiled region model matches the expectations", (t) => {
    const res = runMem();
    if (res.compiler === null) {
        t.skip("no C compiler found; set PPCX_CC to run the compiled memory tests");
        return;
    }
    assert.equal(res.faultCases, 9, "the harness must exercise every fault case");
    assert.ok(res.basicLines >= 27, `basic mode printed ${res.basicLines} lines`);
    const failing = res.failures.slice(0, 5).map((f) => `${f.id}: ${f.detail}`);
    assert.equal(res.failures.length, 0, `failures: ${failing.join(", ")}`);
});
