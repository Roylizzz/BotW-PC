"use strict";

/**
 * Compiled image-loader harness.
 *
 * Builds a synthetic load image with the real tools/ppcx path (synthetic RPX
 * fixture -> buildImage -> serializeImage), generates one C driver that runs
 * the runtime loader (src/runtime/src/ppcx_image.c) over that blob and over a
 * set of hand-corrupted variants, compiles the driver with a real host
 * compiler and compares the output with expectations computed from the
 * fixture and from tools/ppcx/lib/image.js.
 *
 * The expectations cover:
 *   - segment counts, BSS zero-fill and the exact mapped bytes (authored in
 *     the fixture, never derived from the loader);
 *   - every negative case failing with its documented code *before* anything
 *     is written (a sentinel word must survive);
 *   - the Fletcher-32 checksum implementation agreeing with the JS one on
 *     exact block-size boundaries (0, 3, 359, 360, 1000 bytes);
 *   - the file path (ppcx_image_load_file) loading the same bytes.
 *
 * `node tests/loader/run.js` exits non-zero on mismatch. Compiler discovery
 * is shared with the ISA harness (PPCX_CC, then cc/gcc/clang/tcc).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rpxlib = require("../../tools/rpxinfo/lib/rpx.js");
const { buildImage, serializeImage, fletcher32 } = require("../../tools/ppcx/lib/image.js");
const fixture = require("../../tools/ppcx/tests/image-fixture.js");
const { findCompiler } = require("../isa/run.js");

const ROOT = path.resolve(__dirname, "..", "..");
const RUNTIME_INCLUDE = path.join(ROOT, "src", "runtime", "include");
const RUNTIME_SRC = path.join(ROOT, "src", "runtime", "src", "ppcx_image.c");

/* The fixture's highest segment ends below 0x00020800, so 1 MiB is plenty;
 * the arena bound itself (0xC2000000) is exercised by the negative blobs. */
const ARENA_TEST_BYTES = 0x00100000;

function hex32(v) {
    return (v >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function u64hex(v) {
    return hex32(Math.floor(v / 0x100000000)) + hex32(v % 0x100000000);
}

function hex8(v) {
    return (v >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function pattern(len, seed) {
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = (i * 7 + seed) & 0xff;
    return buf;
}

function buildNegatives(blob, sections) {
    const copy = () => Buffer.from(blob);
    const cases = [];
    let b;
    b = copy();
    b[0] = 0x00;
    cases.push({ id: "bad-magic", blob: b, code: -2 });
    cases.push({ id: "short-header", blob: blob.subarray(0, 12), code: -2 });
    b = copy();
    b.writeUInt32BE(0, 8);
    cases.push({ id: "bad-count", blob: b, code: -3 });
    cases.push({ id: "table-past-end", blob: blob.subarray(0, 16 + sections * 16 - 1), code: -4 });
    b = copy();
    b.writeUInt32BE(0, 16 + 4); /* first segment size = 0 */
    cases.push({ id: "empty-segment", blob: b, code: -5 });
    b = copy();
    b.writeUInt32BE(0x10000, 16 + 12); /* first segment flags */
    cases.push({ id: "unknown-flags", blob: b, code: -5 });
    b = copy();
    b.writeUInt32BE(0xc2000000 - 8, 16); /* first segment address */
    cases.push({ id: "outside-arena", blob: b, code: -5 });
    b = copy();
    b.writeUInt32BE(b.readUInt32BE(16) + 4, 16 + 16); /* second segment overlaps the first */
    cases.push({ id: "overlap", blob: b, code: -6 });
    b = copy();
    b.writeUInt32BE(b.length - 1, 16 + 8); /* first payload offset */
    cases.push({ id: "payload-past-end", blob: b, code: -7 });
    b = copy();
    b[b.length - 1] ^= 0x40;
    cases.push({ id: "checksum", blob: b, code: -8 });
    return cases;
}

function cArray(name, buf) {
    const bytes = buf.length > 0 ? buf : Buffer.from([0]);
    const rows = [];
    for (let i = 0; i < bytes.length; i += 16) {
        rows.push("    " + Array.from(bytes.subarray(i, i + 16)).map((v) => `0x${v.toString(16).padStart(2, "0")}`).join(","));
    }
    return [`static const unsigned char ${name}[] = {`, rows.join(",\n"), "};"].join("\n");
}

function cIdent(id) {
    return id.replace(/-/g, "_");
}

function buildScenario() {
    const f = fixture.build();
    const parsed = rpxlib.parseRpx(f.buf);
    const plan = buildImage(f.buf, parsed);
    const blob = serializeImage(plan);
    const stats = plan.stats;
    const patterns = [
        { id: "empty", data: Buffer.alloc(0) },
        { id: "abc", data: Buffer.from("abc", "ascii") },
        { id: "p359", data: pattern(359, 3) },
        { id: "p360", data: pattern(360, 3) },
        { id: "p1000", data: pattern(1000, 3) },
    ];
    const negatives = buildNegatives(blob, stats.sections);

    /* Expected driver output, in the exact order the driver prints it. */
    const expected = [];
    for (const p of patterns) {
        expected.push(`fletcher ${p.id}=${hex32(fletcher32(p.data))}`);
    }
    expected.push("rc null-blob=-1", "msg null-blob=set");
    for (const neg of negatives) {
        expected.push(`rc ${neg.id}=${neg.code}`, `msg ${neg.id}=set`);
    }
    expected.push("mem-after-fail 00020000=CAFEBABE");
    const reportLine = (tag) =>
        `report ${tag} segments=${stats.sections} bss=1 bytes=${u64hex(stats.bytes)} payload=${u64hex(stats.payloadBytes)}`;
    expected.push("rc ok-memory=0", "msg ok-memory=empty", reportLine("ok-memory"));
    for (const [addr, value] of f.expected.probes) expected.push(`mem ${hex8(addr)}=${hex32(value)}`);
    expected.push("rc ok-file=0", "msg ok-file=empty", reportLine("ok-file"));
    for (const [addr, value] of f.expected.probes) expected.push(`mem-file ${hex8(addr)}=${hex32(value)}`);
    expected.push("rc missing-file=-9", "msg missing-file=set");

    return {
        blob,
        negatives,
        patterns,
        expected,
        probeAddrs: f.expected.probes.map(([addr]) => addr),
        arenaBytes: ARENA_TEST_BYTES,
    };
}

function buildDriver(scenario) {
    const out = [];
    out.push("/* Generated by tests/loader/run.js. Synthetic data only. */");
    out.push('#include "ppcx_image.h"');
    out.push("#include <stdio.h>");
    out.push("#include <stdlib.h>");
    out.push("#include <string.h>");
    out.push("");
    out.push("u8 *ppcx_memory;");
    out.push(`#define ARENA_BYTES ${scenario.arenaBytes}u`);
    out.push("");
    out.push(cArray("blob_ok", scenario.blob));
    for (const neg of scenario.negatives) out.push(cArray(`blob_${cIdent(neg.id)}`, neg.blob));
    for (const p of scenario.patterns) out.push(cArray(`pat_${cIdent(p.id)}`, p.data));
    out.push("");
    out.push("static void dump(const char *tag, u32 addr) {");
    out.push('    printf("%s %08X=%08X\\n", tag, (unsigned)addr, (unsigned)ppcx_rd32(addr));');
    out.push("}");
    out.push("");
    out.push("static void report_line(const char *tag, const PpcxImageReport *r) {");
    out.push('    printf("report %s segments=%u bss=%u bytes=%08X%08X payload=%08X%08X\\n", tag,');
    out.push("           (unsigned)r->segments, (unsigned)r->bss_segments,");
    out.push("           (unsigned)(r->bytes >> 32), (unsigned)(r->bytes & 0xFFFFFFFFu),");
    out.push("           (unsigned)(r->payload_bytes >> 32), (unsigned)(r->payload_bytes & 0xFFFFFFFFu));");
    out.push("}");
    out.push("");
    out.push("int main(int argc, char **argv) {");
    out.push("    PpcxImageReport report;");
    out.push("    char err[256];");
    out.push("    long rc;");
    out.push("    (void)argc;");
    out.push("    ppcx_memory = (u8 *)calloc(1, ARENA_BYTES);");
    out.push("    if (ppcx_memory == NULL) return 2;");
    out.push("");
    out.push("    /* Fletcher-32 probes: the C loader and the JS tool must agree. */");
    for (const p of scenario.patterns) {
        out.push(`    printf("fletcher ${p.id}=%08X\\n", (unsigned)ppcx_image_fletcher32(pat_${cIdent(p.id)}, ${p.data.length}u));`);
    }
    out.push("");
    out.push("    /* Validation must fail before anything is written. */");
    out.push('    rc = ppcx_image_load_memory(NULL, 0, &report, err, sizeof err);');
    out.push('    printf("rc null-blob=%ld\\n", rc);');
    out.push('    printf("msg null-blob=%s\\n", err[0] != \'\\0\' ? "set" : "empty");');
    out.push("    ppcx_wr32(0x00020000, 0xCAFEBABEu);");
    for (const neg of scenario.negatives) {
        const name = cIdent(neg.id);
        out.push(`    rc = ppcx_image_load_memory(blob_${name}, sizeof blob_${name}, &report, err, sizeof err);`);
        out.push(`    printf("rc ${neg.id}=%ld\\n", rc);`);
        out.push(`    printf("msg ${neg.id}=%s\\n", err[0] != '\\0' ? "set" : "empty");`);
    }
    out.push('    dump("mem-after-fail", 0x00020000);');
    out.push("");
    out.push("    /* The valid blob: full mapping with BSS zero-fill. */");
    out.push("    memset(ppcx_memory, 0, ARENA_BYTES);");
    out.push("    ppcx_wr32(0x00020204, 0xDEADBEEFu);");
    out.push("    rc = ppcx_image_load_memory(blob_ok, sizeof blob_ok, &report, err, sizeof err);");
    out.push('    printf("rc ok-memory=%ld\\n", rc);');
    out.push('    printf("msg ok-memory=%s\\n", err[0] != \'\\0\' ? "set" : "empty");');
    out.push('    report_line("ok-memory", &report);');
    for (const addr of scenario.probeAddrs) out.push(`    dump("mem", ${"0x" + addr.toString(16).padStart(8, "0")}u);`);
    out.push("");
    out.push("    /* The file path: same blob, same result. */");
    out.push("    memset(ppcx_memory, 0, ARENA_BYTES);");
    out.push("    rc = ppcx_image_load_file(argv[1], &report, err, sizeof err);");
    out.push('    printf("rc ok-file=%ld\\n", rc);');
    out.push('    printf("msg ok-file=%s\\n", err[0] != \'\\0\' ? "set" : "empty");');
    out.push('    report_line("ok-file", &report);');
    for (const addr of scenario.probeAddrs) out.push(`    dump("mem-file", ${"0x" + addr.toString(16).padStart(8, "0")}u);`);
    out.push("    rc = ppcx_image_load_file(argv[2], &report, err, sizeof err);");
    out.push('    printf("rc missing-file=%ld\\n", rc);');
    out.push('    printf("msg missing-file=%s\\n", err[0] != \'\\0\' ? "set" : "empty");');
    out.push("    free(ppcx_memory);");
    out.push("    return 0;");
    out.push("}");
    out.push("");
    return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

function compileAndRun(source, compiler, workDir, blob) {
    const srcPath = path.join(workDir, "loader_harness.c");
    const exePath = path.join(workDir, process.platform === "win32" ? "loader_harness.exe" : "loader_harness");
    const imagePath = path.join(workDir, "image.bin");
    const missingPath = path.join(workDir, "no-such-image.bin");
    fs.writeFileSync(srcPath, source);
    fs.writeFileSync(imagePath, blob);

    const args = [];
    if (!/(^|[\\/])tcc(\.exe)?$/i.test(compiler)) args.push("-std=c11", "-O0", "-Wall");
    args.push("-I", RUNTIME_INCLUDE, "-o", exePath, RUNTIME_SRC, srcPath);
    const r = spawnSync(compiler, args, { encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(
            `compiling the loader harness failed\ncommand: ${compiler} ${args.join(" ")}\n` +
                `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`
        );
    }
    const run = spawnSync(exePath, [imagePath, missingPath], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`the loader harness exited with ${run.status}\n${run.stderr}`);
    return run.stdout;
}

function runLoader(opts = {}) {
    const compiler = opts.compiler !== undefined ? opts.compiler : findCompiler();
    if (!compiler) return { compiler: null, failures: [], skipped: true };

    const workDir = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), "ppcx-loader-"));
    const scenario = buildScenario();
    const source = buildDriver(scenario);
    const output = compileAndRun(source, compiler, workDir, scenario.blob);
    const actual = output.split(/\r?\n/).filter((l) => l.length > 0);

    const failures = [];
    const lines = Math.max(scenario.expected.length, actual.length);
    for (let i = 0; i < lines; i++) {
        if (scenario.expected[i] !== actual[i]) {
            failures.push({ line: i, expected: scenario.expected[i], actual: actual[i] });
        }
    }
    return {
        compiler,
        lines: actual.length,
        negativeBlobs: scenario.negatives.length,
        failures,
        workDir,
    };
}

function main() {
    const res = runLoader();
    if (!res.compiler) {
        console.log("loader: skipped, no C compiler found (set PPCX_CC to one)");
        return 0;
    }
    console.log(
        `loader: ${res.lines} state lines, ${res.negativeBlobs} negative blobs, compiled with ${res.compiler}`
    );
    if (!res.failures.length) {
        console.log("loader: OK, the compiled loader matches the synthetic expectations");
        return 0;
    }
    console.log(`loader: ${res.failures.length} MISMATCHES`);
    for (const f of res.failures.slice(0, 10)) {
        console.log(`  line ${f.line}:\n    expected: ${f.expected}\n    actual:   ${f.actual}`);
    }
    return 1;
}

if (require.main === module) process.exit(main());

module.exports = { runLoader, findCompiler };
