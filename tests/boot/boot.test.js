"use strict";

/**
 * node:test wrapper around the synthetic headless boot harness.
 *
 * The harness runs the game-free RPX fixture from tests/boot/fixture.js
 * through the real pipeline (analyze -> translate -> image -> compile) and
 * boots it with the real runtime, checked-memory model and HLE layer in seven
 * scenarios: a full boot with modeled calls (direct `bl` and address-taken
 * through the dispatcher trampoline), an unmodeled import tolerated as a
 * counted diagnostic no-op, the same call under PPCX_HLE_STRICT=1 (exit 5),
 * a pointer-only getter, a cross-range tail `b` that runs the mid-body start
 * the analysis fixpoint discovered, an unmapped read (exit 9) and the same
 * boot without PPCX_IMAGE (fault at the first data read instead of silent
 * zeroes). Every stream is compared line by line with authored expectations
 * and the boot scenario must repeat byte-identically.
 *
 * It is skipped with a visible message when no C compiler is available;
 * `node tests/boot/run.js` performs the same run from the CLI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { runBoot } = require("./run.js");

test("synthetic RPX boots headless with stable checkpoints", (t) => {
    const res = runBoot();
    if (res.compiler === null) {
        t.skip("no C compiler found; set PPCX_CC to run the compiled boot fixture");
        return;
    }
    assert.deepEqual(res.failures, []);
    assert.equal(res.scenarios, 7);
    assert.equal(res.entries, 5);
    assert.ok(res.transcriptLines >= 30, `expected at least 30 transcript lines, got ${res.transcriptLines}`);
    assert.ok(res.probeLines >= 45, `expected at least 45 probe lines, got ${res.probeLines}`);
});
