"use strict";

/**
 * node:test wrapper around the ISA harness.
 *
 *  - the rotate-mask sweep always runs: all 1024 (MB, ME) pairs are compared
 *    against a from-scratch bit enumeration and, when a C compiler is
 *    available, against the runtime helper the generated code calls;
 *  - the full differential run (every program in cases.js, compiled C vs the
 *    independent oracle) runs when a C compiler is available and is skipped
 *    with a visible message otherwise;
 *  - `node tests/isa/run.js` performs the same differential run from the CLI
 *    and exits non-zero on mismatch, which is what CI uses.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const oracle = require("./oracle.js");
const { findCompiler, runHarness } = require("./run.js");

const RUNTIME_INCLUDE = path.resolve(__dirname, "..", "..", "src", "runtime", "include");

/* Independent construction: enumerate every bit of the 32-bit word and keep
 * the ones from MB through ME (wrapping through bit 31 back to bit 0). */
function maskByEnumeration(mb, me) {
    let m = 0;
    for (let i = 0; i < 32; i++) {
        const inRange = mb <= me ? i >= mb && i <= me : i >= mb || i <= me;
        if (inRange) m = (m | (1 << (31 - i))) >>> 0;
    }
    return m >>> 0;
}

test("rotate mask: all 1024 (MB, ME) pairs match a bit enumeration", () => {
    for (let mb = 0; mb < 32; mb++) {
        for (let me = 0; me < 32; me++) {
            assert.equal(oracle.maskBits(mb, me), maskByEnumeration(mb, me), `MB=${mb} ME=${me}`);
        }
    }
});

test("rotate mask: the C runtime helper matches for all 1024 pairs", (t) => {
    const compiler = findCompiler();
    if (!compiler) {
        t.skip("no C compiler found; set PPCX_CC to run the compiled comparison");
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppcx-mask-"));
    const src = path.join(dir, "mask.c");
    const exe = path.join(dir, process.platform === "win32" ? "mask.exe" : "mask");
    fs.writeFileSync(
        src,
        [
            '#include "ppcx_abi.h"',
            "#include <stdio.h>",
            "int main(void) {",
            "    for (unsigned mb = 0; mb < 32u; mb++)",
            "        for (unsigned me = 0; me < 32u; me++)",
            '            printf("%08x\\n", (unsigned)ppcx_mask_mb_me(mb, me));',
            "    return 0;",
            "}",
            "",
        ].join("\n")
    );
    const args = [];
    if (!/(^|[\\/])tcc(\.exe)?$/i.test(compiler)) args.push("-std=c11", "-O0", "-Wall");
    args.push("-I", RUNTIME_INCLUDE, "-o", exe, src, "-lm");
    let build = spawnSync(compiler, args, { encoding: "utf8" });
    if (build.status !== 0) {
        // Some toolchains (TCC on Windows) link without a separate libm.
        build = spawnSync(compiler, args.filter((a) => a !== "-lm"), { encoding: "utf8" });
    }
    if (build.status !== 0) {
        assert.fail(`compiling the mask helper failed\ncommand: ${compiler} ${args.join(" ")}\n${build.stderr}`);
    }
    const run = spawnSync(exe, [], { encoding: "utf8" });
    assert.equal(run.status, 0, `mask probe exited with ${run.status}\n${run.stderr}`);
    const lines = run.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    assert.equal(lines.length, 1024, "the mask probe must print one line per (MB, ME) pair");
    const mismatches = [];
    for (let mb = 0; mb < 32; mb++) {
        for (let me = 0; me < 32; me++) {
            const expected = oracle.maskBits(mb, me).toString(16).padStart(8, "0");
            const actual = lines[mb * 32 + me];
            if (actual !== expected) mismatches.push(`MB=${mb} ME=${me}: C=${actual} oracle=${expected}`);
        }
    }
    assert.deepEqual(mismatches.slice(0, 8), [], `C mask mismatches (${mismatches.length} total):\n${mismatches.slice(0, 8).join("\n")}`);
});

test("ISA cases: compiled generated code matches the independent oracle", (t) => {
    const res = runHarness();
    if (res.compiler === null) {
        t.skip("no C compiler found; set PPCX_CC to run the differential harness");
        return;
    }
    const failing = res.failures.slice(0, 5).map((f) => `case ${f.id} (${f.name})`);
    assert.equal(res.failures.length, 0, `mismatching cases: ${failing.join(", ")}`);
});
