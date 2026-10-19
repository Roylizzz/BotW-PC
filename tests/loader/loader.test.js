"use strict";

/**
 * node:test wrapper around the compiled image-loader harness.
 *
 * The harness builds a synthetic PPCXIMG1 blob with the real tools/ppcx
 * code, compiles src/runtime/src/ppcx_image.c together with a generated
 * driver, and compares the driver's output (mapped bytes, report numbers,
 * segment permissions, error codes for ten corrupted blobs, Fletcher-32
 * boundaries and the file path) with expectations authored in the synthetic
 * fixture. A second process then writes to the loaded read-only `.text`
 * segment and must fault with exit code 9. It is skipped with a visible
 * message when no C compiler is available; `node tests/loader/run.js`
 * performs the same run from the CLI and exits non-zero on mismatch.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { runLoader } = require("./run.js");

test("image loader: the compiled runtime matches the synthetic expectations", (t) => {
    const res = runLoader();
    if (res.compiler === null) {
        t.skip("no C compiler found; set PPCX_CC to run the compiled loader tests");
        return;
    }
    assert.equal(res.negativeBlobs, 10, "the harness must exercise every negative blob");
    assert.equal(res.readOnlyWrite, true, "a write to the loaded read-only .text must fault with exit 9");
    const failing = res.failures.slice(0, 5).map((f) => `line ${f.line} (${f.expected} != ${f.actual})`);
    assert.equal(res.failures.length, 0, `mismatching lines: ${failing.join(", ")}`);
});
