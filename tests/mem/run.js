"use strict";

/**
 * Compiled checked-memory harness (RUN-003).
 *
 * Generates one C driver that exercises the region map of
 * src/runtime/src/ppcx_mem.c through the real guest accessors in
 * ppcx_abi.h, compiles it with a host compiler and compares the output with
 * expectations authored here (never derived from the implementation):
 *
 *   - raw mode: without ppcx_mem_reset the accessors keep the flat-address
 *     behavior, even outside every (future) region;
 *   - basic mode: region registration (out of order, sorted listing),
 *     duplicate/overlap/invalid return codes, and boundary/unaligned/host
 *     accesses at the first and last byte of each region;
 *   - fault mode: one child process per illegal access; each must print the
 *     exact diagnostic on stderr and exit with code 9, before any byte of
 *     the target address is touched;
 *   - hook mode: the registered fault hook runs before the exit;
 *   - determinism: the same fault twice produces byte-identical output.
 *
 * `node tests/mem/run.js` exits non-zero on mismatch. Compiler discovery is
 * shared with the ISA harness (PPCX_CC, then cc/gcc/clang/tcc).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { findCompiler } = require("../isa/run.js");

const ROOT = path.resolve(__dirname, "..", "..");
const RUNTIME_INCLUDE = path.join(ROOT, "src", "runtime", "include");
const RUNTIME_MEM_SRC = path.join(ROOT, "src", "runtime", "src", "ppcx_mem.c");

/* Regions installed by setup(): stack [0x70000,0x80000), b [0x22000,0x23000),
 * data [0x10000,0x20000). The arena is 1 MiB; the guest-arena bound itself
 * is exercised with a wrap-around fault instead of a 3 GiB allocation. */
const ARENA_TEST_BYTES = 0x00100000;
const STACK_TOP = 0x00080000;
const STACK_BYTES = 0x00010000;
const REGION_DATA = 0x00010000;
const REGION_DATA_SIZE = 0x00010000;
const REGION_B = 0x00022000;
const REGION_B_SIZE = 0x00001000;

function hex32(v) {
    return (v >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function faultLine(kind, size, ea) {
    return `ppcx: guest memory fault: ${kind} of ${size} byte(s) at 0x${hex32(ea)} is not inside any mapped region`;
}

function buildRaw() {
    const code = [];
    const expected = [];
    const stmt = (s) => code.push(`    ${s}`);
    const line = (s, exp) => {
        code.push(`    ${s}`);
        expected.push(exp);
    };
    line('printf("raw-active=%d\\n", ppcx_mem_active);', "raw-active=0");
    stmt("ppcx_wr32(0x00012000u, 0xDEADBEEFu);");
    line('printf("raw-unmapped=%08X\\n", (unsigned)ppcx_rd32(0x00012000u));', "raw-unmapped=DEADBEEF");
    line('printf("raw-regions=%u\\n", ppcx_mem_region_count());', "raw-regions=0");
    return { code, expected };
}

function buildBasic() {
    const code = [];
    const expected = [];
    const stmt = (s) => code.push(`    ${s}`);
    const line = (s, exp) => {
        code.push(`    ${s}`);
        expected.push(exp);
    };

    line('printf("active=%d\\n", ppcx_mem_active);', "active=1");
    line('printf("regions=%u\\n", ppcx_mem_region_count());', "regions=3");
    code.push("    for (unsigned k = 0; k < ppcx_mem_region_count(); k++) {");
    code.push("        u32 s, z; const char *t;");
    code.push("        if (!ppcx_mem_region_at(k, &s, &z, &t)) return 3;");
    code.push('        printf("region%u=%08X+%08X %s\\n", k, (unsigned)s, (unsigned)z, t);');
    code.push("    }");
    expected.push(
        `region0=${hex32(REGION_DATA)}+${hex32(REGION_DATA_SIZE)} data`,
        `region1=${hex32(REGION_B)}+${hex32(REGION_B_SIZE)} b`,
        `region2=${hex32(STACK_TOP - STACK_BYTES)}+${hex32(STACK_BYTES)} stack`
    );

    /* Duplicate registration succeeds without doubling the map; overlapping,
     * empty and out-of-arena ranges fail with their documented codes. */
    line('printf("add-dup=%d\\n", ppcx_mem_add(0x00010000u, 0x00010000u, "dup"));', "add-dup=0");
    line('printf("add-overlap=%d\\n", ppcx_mem_add(0x00018000u, 0x00002000u, "over"));', "add-overlap=-1");
    line('printf("add-invalid=%d\\n", ppcx_mem_add(0x00030000u, 0u, "zero"));', "add-invalid=-3");
    line('printf("add-outside=%d\\n", ppcx_mem_add(0xC1FFFFFCu, 8u, "past"));', "add-outside=-3");
    line('printf("regions-unchanged=%u\\n", ppcx_mem_region_count());', "regions-unchanged=3");

    /* Boundary and unaligned accesses, all inside a mapped region. */
    stmt("ppcx_wr32(0x00010000u, 0x11223344u);");
    line('printf("rd32-first=%08X\\n", (unsigned)ppcx_rd32(0x00010000u));', "rd32-first=11223344");
    line('printf("rd8-first=%02X\\n", (unsigned)ppcx_rd8(0x00010000u));', "rd8-first=11");
    line('printf("rd16-first=%04X\\n", (unsigned)ppcx_rd16(0x00010000u));', "rd16-first=1122");
    code.push("    { u64 v = ppcx_rd64(0x00010000u);");
    code.push('      printf("rd64-first=%08X%08X\\n", (unsigned)(v >> 32), (unsigned)v); }');
    expected.push("rd64-first=1122334400000000");

    stmt("ppcx_wr32(0x00010011u, 0xAABBCCDDu);");
    line('printf("rd32-unaligned=%08X\\n", (unsigned)ppcx_rd32(0x00010011u));', "rd32-unaligned=AABBCCDD");
    line('printf("rd8-unaligned=%02X\\n", (unsigned)ppcx_rd8(0x00010011u));', "rd8-unaligned=AA");

    /* The last 8 bytes of the "data" region, ending exactly at its bound. */
    stmt("ppcx_wr64(0x0001FFF8u, 0x0102030405060708u);");
    stmt("ppcx_wr16(0x0001FFFEu, 0xBEEFu);");
    code.push("    { u64 v = ppcx_rd64(0x0001FFF8u);");
    code.push('      printf("rd64-boundary=%08X%08X\\n", (unsigned)(v >> 32), (unsigned)v); }');
    expected.push("rd64-boundary=010203040506BEEF");
    line('printf("rd8-last=%02X\\n", (unsigned)ppcx_rd8(0x0001FFFFu));', "rd8-last=EF");

    /* First and last byte/word of the small "b" region. */
    stmt("ppcx_wr8(0x00022000u, 0x5Au);");
    line('printf("rd8-b-first=%02X\\n", (unsigned)ppcx_rd8(0x00022000u));', "rd8-b-first=5A");
    stmt("ppcx_wr32(0x00022FFCu, 0xA1B2C3D4u);");
    line('printf("rd32-b-last=%08X\\n", (unsigned)ppcx_rd32(0x00022FFCu));', "rd32-b-last=A1B2C3D4");

    /* The stack region, from its top. */
    stmt("ppcx_wr64(0x0007FFF8u, 0x0011223344556677u);");
    code.push("    { u64 v = ppcx_rd64(0x0007FFF8u);");
    code.push('      printf("rd64-stack=%08X%08X\\n", (unsigned)(v >> 32), (unsigned)v); }');
    expected.push("rd64-stack=0011223344556677");

    /* dcbz clears exactly one 32-byte block inside the region. */
    stmt("ppcx_wr32(0x00010020u, 0xFFFFFFFFu);");
    stmt("ppcx_wr32(0x00010040u, 0xCAFEBABEu);");
    stmt("ppcx_dcbz(0x00010020u);");
    line('printf("rd32-dcbz-head=%08X\\n", (unsigned)ppcx_rd32(0x00010020u));', "rd32-dcbz-head=00000000");
    line('printf("rd32-dcbz-tail=%08X\\n", (unsigned)ppcx_rd32(0x0001003Cu));', "rd32-dcbz-tail=00000000");
    line('printf("rd32-dcbz-after=%08X\\n", (unsigned)ppcx_rd32(0x00010040u));', "rd32-dcbz-after=CAFEBABE");

    /* Host-order (byte-reversed) accessors round-trip inside the region. */
    stmt("ppcx_wr32_host(0x00010030u, 0x12345678u);");
    line('printf("rd32-host=%08X\\n", (unsigned)ppcx_rd32_host(0x00010030u));', "rd32-host=12345678");
    stmt("ppcx_wr16_host(0x00010034u, 0x9ABCu);");
    line('printf("rd16-host=%04X\\n", (unsigned)ppcx_rd16_host(0x00010034u));', "rd16-host=9ABC");

    line('printf("final-ok=1\\n");', "final-ok=1");
    return { code, expected };
}

function buildFaults() {
    return [
        { id: "read-past-region-end", stmt: "ppcx_rd32(0x00020000u);", kind: "read", size: 4, ea: 0x00020000 },
        { id: "read-before-region-start", stmt: "ppcx_rd8(0x0000FFFFu);", kind: "read", size: 1, ea: 0x0000ffff },
        { id: "write-straddles-region-end", stmt: "ppcx_wr16(0x0001FFFFu, 0x1234u);", kind: "write", size: 2, ea: 0x0001ffff },
        { id: "read64-wraps-address-space", stmt: "ppcx_rd64(0xFFFFFFFCu);", kind: "read", size: 8, ea: 0xfffffffc },
        { id: "read-in-arena-hole", stmt: "ppcx_rd32(0x00030000u);", kind: "read", size: 4, ea: 0x00030000 },
        { id: "write-in-arena-hole", stmt: "ppcx_wr32(0x00023000u, 1u);", kind: "write", size: 4, ea: 0x00023000 },
        { id: "host-read-in-arena-hole", stmt: "ppcx_rd32_host(0x00030000u);", kind: "read", size: 4, ea: 0x00030000 },
        { id: "dcbz-unmapped", stmt: "ppcx_dcbz(0x00023020u);", kind: "write", size: 32, ea: 0x00023020 },
        { id: "read-below-stack", stmt: "ppcx_rd32(0x0006FFFCu);", kind: "read", size: 4, ea: 0x0006fffc },
    ];
}

function buildDriver(raw, basic, faults) {
    const out = [];
    out.push("/* Generated by tests/mem/run.js. Synthetic data only. */");
    out.push('#include "ppcx_mem.h"');
    out.push("#include <stdio.h>");
    out.push("#include <stdlib.h>");
    out.push("#include <string.h>");
    out.push("");
    out.push("u8 *ppcx_memory;");
    out.push(`#define ARENA_BYTES 0x${hex32(ARENA_TEST_BYTES)}u`);
    out.push("");
    out.push("static void setup(void) {");
    out.push(`    ppcx_mem_reset(0x${hex32(STACK_TOP)}u, 0x${hex32(STACK_BYTES)}u);`);
    out.push(`    ppcx_mem_add(0x${hex32(REGION_B)}u, 0x${hex32(REGION_B_SIZE)}u, "b");`);
    out.push(`    ppcx_mem_add(0x${hex32(REGION_DATA)}u, 0x${hex32(REGION_DATA_SIZE)}u, "data");`);
    out.push("}");
    out.push("");
    out.push("static void my_hook(u32 ea, unsigned size, unsigned write) {");
    out.push('    printf("hook %08X %u %u\\n", (unsigned)ea, size, write);');
    out.push("}");
    out.push("");
    out.push("int main(int argc, char **argv) {");
    out.push("    const char *mode;");
    out.push("    ppcx_memory = (u8 *)calloc(1, ARENA_BYTES);");
    out.push("    if (ppcx_memory == NULL) return 2;");
    out.push("    if (argc < 2) return 2;");
    out.push("    mode = argv[1];");
    out.push('    if (strcmp(mode, "raw") == 0) {');
    out.push(...raw.code);
    out.push("        return 0;");
    out.push("    }");
    out.push("    setup();");
    out.push('    if (strcmp(mode, "basic") == 0) {');
    out.push(...basic.code);
    out.push("        return 0;");
    out.push("    }");
    out.push('    if (strcmp(mode, "hook") == 0) {');
    out.push("        ppcx_mem_set_fault_hook(my_hook);");
    out.push('        printf("hook-set=1\\n");');
    out.push("        ppcx_wr8(0x00023000u, 1u);");
    out.push('        printf("hook-survived=1\\n");');
    out.push("        return 0;");
    out.push("    }");
    out.push('    if (strcmp(mode, "fault") == 0 && argc >= 3) {');
    faults.forEach((f, i) => {
        out.push(`        ${i === 0 ? "if" : "else if"} (strcmp(argv[2], "${f.id}") == 0) { ${f.stmt} }`);
    });
    out.push('        printf("fault-survived=%s\\n", argv[2]);');
    out.push("        return 0;");
    out.push("    }");
    out.push("    return 2;");
    out.push("}");
    out.push("");
    return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

function runCompiled(compiler, workDir) {
    const raw = buildRaw();
    const basic = buildBasic();
    const faults = buildFaults();
    const source = buildDriver(raw, basic, faults);

    const srcPath = path.join(workDir, "mem_harness.c");
    const exePath = path.join(workDir, process.platform === "win32" ? "mem_harness.exe" : "mem_harness");
    fs.writeFileSync(srcPath, source);

    const args = [];
    if (!/(^|[\\/])tcc(\.exe)?$/i.test(compiler)) args.push("-std=c11", "-O0", "-Wall");
    args.push("-I", RUNTIME_INCLUDE, "-o", exePath, RUNTIME_MEM_SRC, srcPath);
    const compile = spawnSync(compiler, args, { encoding: "utf8" });
    if (compile.status !== 0) {
        throw new Error(
            `compiling the memory harness failed\ncommand: ${compiler} ${args.join(" ")}\n` +
                `stdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`
        );
    }

    const failures = [];
    const run = (args2) => spawnSync(exePath, args2, { encoding: "utf8" });
    const lines = (s) => (s.length === 0 ? [] : s.split(/\r?\n/).filter((l) => l.length > 0));

    /* Raw mode: no model installed, flat-address behavior preserved. */
    const rawRun = run(["raw"]);
    if (rawRun.status !== 0) {
        failures.push({ id: "raw", detail: `exited with ${rawRun.status}: ${rawRun.stderr}` });
    } else {
        const actual = lines(rawRun.stdout);
        for (let i = 0; i < Math.max(raw.expected.length, actual.length); i++) {
            if (raw.expected[i] !== actual[i]) {
                failures.push({ id: `raw line ${i}`, detail: `${raw.expected[i]} != ${actual[i]}` });
            }
        }
    }

    /* Basic mode: registration, boundaries and round-trips. */
    const basicRun = run(["basic"]);
    if (basicRun.status !== 0) {
        failures.push({ id: "basic", detail: `exited with ${basicRun.status}: ${basicRun.stderr}` });
    } else {
        const actual = lines(basicRun.stdout);
        for (let i = 0; i < Math.max(basic.expected.length, actual.length); i++) {
            if (basic.expected[i] !== actual[i]) {
                failures.push({ id: `basic line ${i}`, detail: `${basic.expected[i]} != ${actual[i]}` });
            }
        }
    }

    /* Fault mode: one process per illegal access, exit 9, exact diagnostic. */
    for (const f of faults) {
        const want = faultLine(f.kind, f.size, f.ea);
        const r = run(["fault", f.id]);
        const stderr = lines(r.stderr);
        if (r.status !== 9) {
            failures.push({ id: f.id, detail: `exit ${r.status} instead of 9 (stderr: ${stderr.join(" | ")})` });
            continue;
        }
        if (stderr.length !== 1 || stderr[0] !== want) {
            failures.push({ id: f.id, detail: `stderr ${JSON.stringify(stderr)} != ${JSON.stringify([want])}` });
        }
        const stdout = lines(r.stdout);
        if (stdout.length !== 0) {
            failures.push({ id: f.id, detail: `unexpected stdout ${JSON.stringify(stdout)}` });
        }
    }

    /* Hook mode: the hook runs before the exit with the exact fault tuple. */
    const wantHook = faultLine("write", 1, 0x00023000);
    const hookRun = run(["hook"]);
    const hookOut = lines(hookRun.stdout);
    const hookErr = lines(hookRun.stderr);
    if (hookRun.status !== 9 || hookOut.join("|") !== "hook-set=1|hook 00023000 1 1" || hookErr.length !== 1 || hookErr[0] !== wantHook) {
        failures.push({
            id: "hook",
            detail: `exit ${hookRun.status}, stdout ${JSON.stringify(hookOut)}, stderr ${JSON.stringify(hookErr)}`,
        });
    }

    /* Determinism: the same fault twice is byte-identical on both streams. */
    const first = run(["fault", faults[0].id]);
    const second = run(["fault", faults[0].id]);
    if (first.status !== second.status || first.stdout !== second.stdout || first.stderr !== second.stderr) {
        failures.push({ id: "determinism", detail: "two runs of the same fault differed" });
    }

    return {
        basicLines: lines(basicRun.stdout).length,
        rawLines: lines(rawRun.stdout).length,
        faultCases: faults.length,
        failures,
    };
}

function runMem(opts = {}) {
    const compiler = opts.compiler !== undefined ? opts.compiler : findCompiler();
    if (!compiler) return { compiler: null, basicLines: 0, rawLines: 0, faultCases: 0, failures: [], skipped: true };
    const workDir = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), "ppcx-mem-"));
    const res = runCompiled(compiler, workDir);
    return { compiler, workDir, ...res };
}

function main() {
    const res = runMem();
    if (!res.compiler) {
        console.log("mem: skipped, no C compiler found (set PPCX_CC to one)");
        return 0;
    }
    console.log(
        `mem: basic ${res.basicLines} lines, raw ${res.rawLines} lines, ${res.faultCases} fault cases, ` +
            `hook and determinism checks, compiled with ${res.compiler}`
    );
    if (!res.failures.length) {
        console.log("mem: OK, checked accesses match the mapped regions and faults stop deterministically");
        return 0;
    }
    console.log(`mem: ${res.failures.length} FAILURES`);
    for (const f of res.failures.slice(0, 10)) {
        console.log(`  ${f.id}: ${f.detail}`);
    }
    return 1;
}

if (require.main === module) process.exit(main());

module.exports = { runMem, findCompiler };
