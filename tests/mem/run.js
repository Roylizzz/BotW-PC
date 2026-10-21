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
 *   - basic mode: region registration (out of order, sorted listing), the
 *     permission of each region, duplicate/overlap/invalid return codes
 *     (including a duplicate with different permissions), and
 *     boundary/unaligned/host accesses at the first and last byte of each
 *     region;
 *   - fault mode: one child process per illegal access; each must print the
 *     exact diagnostic on stderr and exit with code 9, before any byte of
 *     the target address is touched. This covers accesses outside every
 *     region and writes to a read-only region;
 *   - hook mode: the registered fault hook runs before the exit, for both
 *     kinds of fault;
 *   - HLE mode: the memory/cache models in ppcx_hle.c run with the real
 *     region map installed and preserve their documented copy/fill/block
 *     semantics; dedicated child processes then check that a read-only
 *     destination, an unmapped destination/source and a read-only DCZeroRange
 *     block stop with the same deterministic diagnostics;
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
const RUNTIME_HLE_SRC = path.join(ROOT, "src", "runtime", "src", "ppcx_hle.c");

/* Regions installed by setup(): stack [0x70000,0x80000), b [0x22000,0x23000),
 * data [0x10000,0x20000) and the read-only ro [0x24000,0x25000). The arena is
 * 1 MiB; the guest-arena bound itself is exercised with a wrap-around fault
 * instead of a 3 GiB allocation. */
const ARENA_TEST_BYTES = 0x00100000;
const STACK_TOP = 0x00080000;
const STACK_BYTES = 0x00010000;
const REGION_DATA = 0x00010000;
const REGION_DATA_SIZE = 0x00010000;
const REGION_B = 0x00022000;
const REGION_B_SIZE = 0x00001000;
const REGION_RO = 0x00024000;
const REGION_RO_SIZE = 0x00001000;

function hex32(v) {
    return (v >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function faultLine(kind, size, ea) {
    return `ppcx: guest memory fault: ${kind} of ${size} byte(s) at 0x${hex32(ea)} is not inside any mapped region`;
}

function permLine(size, ea, tag, start, regionSize) {
    return (
        `ppcx: guest memory fault: write of ${size} byte(s) at 0x${hex32(ea)} is not allowed ` +
        `(region "${tag}" at 0x${hex32(start)}+${regionSize} is read-only)`
    );
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
    line('printf("regions=%u\\n", ppcx_mem_region_count());', "regions=4");
    code.push("    for (unsigned k = 0; k < ppcx_mem_region_count(); k++) {");
    code.push("        u32 s, z; const char *t;");
    code.push("        if (!ppcx_mem_region_at(k, &s, &z, &t)) return 3;");
    code.push('        printf("region%u=%08X+%08X %s\\n", k, (unsigned)s, (unsigned)z, t);');
    code.push("    }");
    expected.push(
        `region0=${hex32(REGION_DATA)}+${hex32(REGION_DATA_SIZE)} data`,
        `region1=${hex32(REGION_B)}+${hex32(REGION_B_SIZE)} b`,
        `region2=${hex32(REGION_RO)}+${hex32(REGION_RO_SIZE)} ro`,
        `region3=${hex32(STACK_TOP - STACK_BYTES)}+${hex32(STACK_BYTES)} stack`
    );

    /* Permissions are attached to each region; the read-only region is
     * readable (the arena starts zeroed) but rejects writes in fault mode. */
    code.push("    for (unsigned k = 0; k < ppcx_mem_region_count(); k++) {");
    code.push("        unsigned p;");
    code.push("        if (!ppcx_mem_region_permissions(k, &p)) return 4;");
    code.push('        printf("perm%u=%u\\n", k, p);');
    code.push("    }");
    expected.push("perm0=1", "perm1=1", "perm2=0", "perm3=1");
    line('printf("rd32-ro=%08X\\n", (unsigned)ppcx_rd32(0x00024000u));', "rd32-ro=00000000");

    /* Duplicate registration succeeds without doubling the map; an exact
     * duplicate with different permissions is a conflict. Overlapping, empty,
     * unknown-permission and out-of-arena ranges fail with their codes. */
    line('printf("add-dup=%d\\n", ppcx_mem_add(0x00010000u, 0x00010000u, "dup"));', "add-dup=0");
    line(
        'printf("add-dup-perm=%d\\n", ppcx_mem_add_perm(0x00010000u, 0x00010000u, "dup", PPCX_MEM_WRITE));',
        "add-dup-perm=0"
    );
    line(
        'printf("add-conflict=%d\\n", ppcx_mem_add_perm(0x00010000u, 0x00010000u, "dup", 0u));',
        "add-conflict=-4"
    );
    line('printf("add-overlap=%d\\n", ppcx_mem_add(0x00018000u, 0x00002000u, "over"));', "add-overlap=-1");
    line('printf("add-invalid=%d\\n", ppcx_mem_add(0x00030000u, 0u, "zero"));', "add-invalid=-3");
    line('printf("add-badperm=%d\\n", ppcx_mem_add_perm(0x00026000u, 0x00001000u, "bad", 0x80u));', "add-badperm=-3");
    line('printf("add-outside=%d\\n", ppcx_mem_add(0xC1FFFFFCu, 8u, "past"));', "add-outside=-3");
    line('printf("regions-unchanged=%u\\n", ppcx_mem_region_count());', "regions-unchanged=4");

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
        {
            id: "write-to-readonly",
            stmt: "ppcx_wr32(0x00024000u, 1u);",
            line: permLine(4, 0x00024000, "ro", REGION_RO, REGION_RO_SIZE),
        },
        {
            id: "write8-to-readonly-last",
            stmt: "ppcx_wr8(0x00024FFFu, 1u);",
            line: permLine(1, 0x00024fff, "ro", REGION_RO, REGION_RO_SIZE),
        },
        {
            id: "write-straddles-readonly-last-word",
            stmt: "ppcx_wr16(0x00024FFEu, 0x1234u);",
            line: permLine(2, 0x00024ffe, "ro", REGION_RO, REGION_RO_SIZE),
        },
        {
            id: "dcbz-readonly",
            stmt: "ppcx_dcbz(0x00024020u);",
            line: permLine(32, 0x00024020, "ro", REGION_RO, REGION_RO_SIZE),
        },
    ];
}

function buildHle() {
    const code = [];
    const expected = [];
    const stmt = (s) => code.push(`    ${s}`);
    const line = (s, exp) => {
        code.push(`    ${s}`);
        expected.push(exp);
    };

    code.push("    Cpu cpu;");
    code.push("    unsigned k;");
    stmt("ppcx_wr32(0x00010000u, 0x11223344u);");
    stmt("ppcx_wr32(0x00010004u, 0x55667788u);");

    /* OSBlockMove(dst, src, size, flush): memmove-like, dst returned in r3. */
    stmt("memset(&cpu, 0, sizeof cpu);");
    stmt("cpu.gpr[3] = 0x00011000u; cpu.gpr[4] = 0x00010000u; cpu.gpr[5] = 8u; cpu.gpr[6] = 1u;");
    line('printf("hle-move=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMove"));', "hle-move=1");
    line('printf("hle-move-r3=%08X\\n", (unsigned)cpu.gpr[3]);', "hle-move-r3=00011000");
    line(
        'printf("hle-move-data=%08X%08X\\n", (unsigned)ppcx_rd32(0x00011000u), (unsigned)ppcx_rd32(0x00011004u));',
        "hle-move-data=1122334455667788"
    );

    /* Overlap (dst > src and dst < src+size) must still preserve the bytes. */
    code.push("    for (k = 0; k < 8; k++) ppcx_wr8(0x00010020u + k, (u8)k);");
    stmt("cpu.gpr[3] = 0x00010024u; cpu.gpr[4] = 0x00010020u; cpu.gpr[5] = 8u;");
    line('printf("hle-overlap=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMove"));', "hle-overlap=1");
    line(
        'printf("hle-overlap-data=%08X%08X\\n", (unsigned)ppcx_rd32(0x00010024u), (unsigned)ppcx_rd32(0x00010028u));',
        "hle-overlap-data=0001020304050607"
    );

    /* OSBlockSet(dst, u8 value, size): dst returned in r3. */
    stmt("cpu.gpr[3] = 0x00012000u; cpu.gpr[4] = 0x5Au; cpu.gpr[5] = 4u;");
    line('printf("hle-set=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockSet"));', "hle-set=1");
    line('printf("hle-set-r3=%08X\\n", (unsigned)cpu.gpr[3]);', "hle-set-r3=00012000");
    line('printf("hle-set-data=%08X\\n", (unsigned)ppcx_rd32(0x00012000u));', "hle-set-data=5A5A5A5A");

    /* memcpy/memset share the same return and truncation contracts. */
    stmt("cpu.gpr[3] = 0x00012100u; cpu.gpr[4] = 0x00010000u; cpu.gpr[5] = 4u;");
    line('printf("hle-memcpy=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.memcpy"));', "hle-memcpy=1");
    line('printf("hle-memcpy-r3=%08X\\n", (unsigned)cpu.gpr[3]);', "hle-memcpy-r3=00012100");
    line('printf("hle-memcpy-data=%08X\\n", (unsigned)ppcx_rd32(0x00012100u));', "hle-memcpy-data=11223344");
    stmt("cpu.gpr[3] = 0x00012200u; cpu.gpr[4] = 0x1ABu; cpu.gpr[5] = 2u;");
    line('printf("hle-memset=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.memset"));', "hle-memset=1");
    line('printf("hle-memset-r3=%08X\\n", (unsigned)cpu.gpr[3]);', "hle-memset-r3=00012200");
    line('printf("hle-memset-data=%04X\\n", (unsigned)ppcx_rd16(0x00012200u));', "hle-memset-data=ABAB");

    /* DCZeroRange(addr, size) zeroes the containing 0x20-byte block once. */
    code.push("    for (k = 0; k < 0x40; k++) ppcx_wr8(0x00012300u + k, 0xFFu);");
    stmt("cpu.gpr[3] = 0x00012301u; cpu.gpr[4] = 1u;");
    line('printf("hle-zero=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.DCZeroRange"));', "hle-zero=1");
    line('printf("hle-zero-head=%08X\\n", (unsigned)ppcx_rd32(0x00012300u));', "hle-zero-head=00000000");
    line('printf("hle-zero-tail=%08X\\n", (unsigned)ppcx_rd32(0x00012320u));', "hle-zero-tail=FFFFFFFF");

    /* Cache maintenance is a typed no-op on the coherent flat arena. */
    stmt("ppcx_wr32(0x00012400u, 0xDEADBEEFu);");
    stmt("cpu.gpr[3] = 0x00012400u; cpu.gpr[4] = 4u;");
    line('printf("hle-flush=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.DCFlushRange"));', "hle-flush=1");
    line('printf("hle-flush-nosync=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.DCFlushRangeNoSync"));', "hle-flush-nosync=1");
    line('printf("hle-invalidate=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.DCInvalidateRange"));', "hle-invalidate=1");
    line('printf("hle-barrier=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.OSMemoryBarrier"));', "hle-barrier=1");
    line('printf("hle-flush-data=%08X\\n", (unsigned)ppcx_rd32(0x00012400u));', "hle-flush-data=DEADBEEF");

    /* Reading a read-only region through HLE is allowed. */
    stmt("cpu.gpr[3] = 0x00012500u; cpu.gpr[4] = 0x00024000u; cpu.gpr[5] = 4u;");
    line('printf("hle-ro-src=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMove"));', "hle-ro-src=1");
    line('printf("hle-ro-data=%08X\\n", (unsigned)ppcx_rd32(0x00012500u));', "hle-ro-data=00000000");

    /* The clock's system-info record lives in the reserved HLE data page.
     * Map that page for this mode and verify the guest-visible record. */
    stmt('printf("hle-sysinfo-map=%d\\n", ppcx_mem_add_perm(0x00090000u, 0x00001000u, "hle-data", PPCX_MEM_WRITE));');
    expected.push("hle-sysinfo-map=0");
    stmt("ppcx_hle_tls_reset();");
    stmt("memset(&cpu, 0, sizeof cpu);");
    line('printf("hle-sysinfo=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.OSGetSystemInfo"));', "hle-sysinfo=1");
    line('printf("hle-sysinfo-r3=%08X\\n", (unsigned)cpu.gpr[3]);', "hle-sysinfo-r3=00090000");
    line('printf("hle-sysinfo-bus=%08X\\n", (unsigned)ppcx_rd32(0x00090000u));', "hle-sysinfo-bus=0ED1B768");
    line('printf("hle-sysinfo-core=%08X\\n", (unsigned)ppcx_rd32(0x00090004u));', "hle-sysinfo-core=4A189508");
    line(
        'printf("hle-sysinfo-base=%08X%08X\\n", (unsigned)(ppcx_rd64(0x00090008u) >> 32), (unsigned)ppcx_rd64(0x00090008u));',
        "hle-sysinfo-base=00B531CFBDFB8F00"
    );

    /* The TLSIndex lives in ordinary guest data; __tls_get_addr resolves the
     * main module to the zero-filled block above the system-info record. */
    stmt("ppcx_wr32(0x00013000u, 1u); ppcx_wr32(0x00013004u, 4u);");
    stmt("memset(&cpu, 0, sizeof cpu); cpu.gpr[3] = 0x00013000u;");
    line('printf("hle-tls=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.__tls_get_addr"));', "hle-tls=1");
    line('printf("hle-tls-r3=%08X\\n", (unsigned)cpu.gpr[3]);', "hle-tls-r3=00090104");
    stmt("ppcx_wr32(cpu.gpr[3], 0x5A5A1234u);");
    line('printf("hle-tls-data=%08X\\n", (unsigned)ppcx_rd32(0x00090104u));', "hle-tls-data=5A5A1234");
    stmt("ppcx_wr32(0x00013000u, 2u); cpu.gpr[3] = 0x00013000u;");
    line('printf("hle-tls-bad-module=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.__tls_get_addr"));', "hle-tls-bad-module=1");
    line('printf("hle-tls-bad-r3=%08X\\n", (unsigned)cpu.gpr[3]);', "hle-tls-bad-r3=00000000");

    line('printf("hle-unknown=%d\\n", ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMoveX"));', "hle-unknown=0");
    return { code, expected };
}

function buildHleFaults() {
    return [
        {
            id: "hle-move-dst-readonly",
            stmt:
                "Cpu cpu; memset(&cpu, 0, sizeof cpu); " +
                "cpu.gpr[3] = 0x00024000u; cpu.gpr[4] = 0x00010000u; cpu.gpr[5] = 4u; " +
                'ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMove");',
            line: permLine(4, 0x00024000, "ro", REGION_RO, REGION_RO_SIZE),
        },
        {
            id: "hle-set-unmapped",
            stmt:
                "Cpu cpu; memset(&cpu, 0, sizeof cpu); " +
                "cpu.gpr[3] = 0x00023000u; cpu.gpr[4] = 1u; cpu.gpr[5] = 4u; " +
                'ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockSet");',
            line: faultLine("write", 4, 0x00023000),
        },
        {
            id: "hle-move-src-unmapped",
            stmt:
                "Cpu cpu; memset(&cpu, 0, sizeof cpu); " +
                "cpu.gpr[3] = 0x00010000u; cpu.gpr[4] = 0x00023000u; cpu.gpr[5] = 4u; " +
                'ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMove");',
            line: faultLine("read", 4, 0x00023000),
        },
        {
            id: "hle-zero-readonly-block",
            stmt:
                "Cpu cpu; memset(&cpu, 0, sizeof cpu); " +
                "cpu.gpr[3] = 0x00024001u; cpu.gpr[4] = 1u; " +
                'ppcx_hle_dispatch_named(&cpu, "coreinit.DCZeroRange");',
            line: permLine(32, 0x00024000, "ro", REGION_RO, REGION_RO_SIZE),
        },
        {
            id: "hle-tls-index-unmapped",
            stmt:
                "Cpu cpu; memset(&cpu, 0, sizeof cpu); " +
                "cpu.gpr[3] = 0x00023000u; " +
                'ppcx_hle_dispatch_named(&cpu, "coreinit.__tls_get_addr");',
            line: faultLine("read", 8, 0x00023000),
        },
    ];
}

function buildDriver(raw, basic, hle, hleFaults, faults) {
    const out = [];
    out.push("/* Generated by tests/mem/run.js. Synthetic data only. */");
    out.push('#include "ppcx_mem.h"');
    out.push('#include "ppcx_hle.h"');
    out.push("#include <stdio.h>");
    out.push("#include <stdlib.h>");
    out.push("#include <string.h>");
    out.push("");
    out.push("u8 *ppcx_memory;");
    out.push(`#define ARENA_BYTES 0x${hex32(ARENA_TEST_BYTES)}u`);
    out.push("");
    out.push("static void setup(void) {");
    out.push(`    ppcx_mem_reset(0x${hex32(STACK_TOP)}u, 0x${hex32(STACK_BYTES)}u);`);
    out.push(
        `    ppcx_mem_add_perm(0x${hex32(REGION_B)}u, 0x${hex32(REGION_B_SIZE)}u, "b", PPCX_MEM_WRITE);`
    );
    out.push(
        `    ppcx_mem_add_perm(0x${hex32(REGION_DATA)}u, 0x${hex32(REGION_DATA_SIZE)}u, "data", PPCX_MEM_WRITE);`
    );
    out.push(`    ppcx_mem_add_perm(0x${hex32(REGION_RO)}u, 0x${hex32(REGION_RO_SIZE)}u, "ro", 0u);`);
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
    out.push('    if (strcmp(mode, "hle") == 0) {');
    out.push(...hle.code);
    out.push("        return 0;");
    out.push("    }");
    hleFaults.forEach((f) => {
        out.push(`    if (strcmp(mode, "${f.id}") == 0) { ${f.stmt} return 0; }`);
    });
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
    out.push('    if (strcmp(mode, "hook-ro") == 0) {');
    out.push("        ppcx_mem_set_fault_hook(my_hook);");
    out.push('        printf("hook-set=1\\n");');
    out.push("        ppcx_wr32(0x00024000u, 1u);");
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
    const hle = buildHle();
    const hleFaults = buildHleFaults();
    const faults = buildFaults();
    const source = buildDriver(raw, basic, hle, hleFaults, faults);

    const srcPath = path.join(workDir, "mem_harness.c");
    const exePath = path.join(workDir, process.platform === "win32" ? "mem_harness.exe" : "mem_harness");
    fs.writeFileSync(srcPath, source);

    const args = [];
    if (!/(^|[\\/])tcc(\.exe)?$/i.test(compiler)) args.push("-std=c11", "-O0", "-Wall");
    args.push("-I", RUNTIME_INCLUDE, "-o", exePath, RUNTIME_MEM_SRC, RUNTIME_HLE_SRC, srcPath);
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

    /* HLE mode: memory/cache models under the real region map. */
    const hleRun = run(["hle"]);
    if (hleRun.status !== 0) {
        failures.push({ id: "hle", detail: `exited with ${hleRun.status}: ${hleRun.stderr}` });
    } else {
        const actual = lines(hleRun.stdout);
        for (let i = 0; i < Math.max(hle.expected.length, actual.length); i++) {
            if (hle.expected[i] !== actual[i]) {
                failures.push({ id: `hle line ${i}`, detail: `${hle.expected[i]} != ${actual[i]}` });
            }
        }
    }

    /* HLE fault mode: one process per rejected operation, exit 9, exact
     * diagnostic and no stdout (the model validates before touching memory). */
    for (const f of hleFaults) {
        const r = run([f.id]);
        const stderr = lines(r.stderr);
        if (r.status !== 9) {
            failures.push({ id: f.id, detail: `exit ${r.status} instead of 9 (stderr: ${stderr.join(" | ")})` });
            continue;
        }
        if (stderr.length !== 1 || stderr[0] !== f.line) {
            failures.push({ id: f.id, detail: `stderr ${JSON.stringify(stderr)} != ${JSON.stringify([f.line])}` });
        }
        const stdout = lines(r.stdout);
        if (stdout.length !== 0) {
            failures.push({ id: f.id, detail: `unexpected stdout ${JSON.stringify(stdout)}` });
        }
    }

    /* Fault mode: one process per illegal access, exit 9, exact diagnostic. */
    for (const f of faults) {
        const want = f.line || faultLine(f.kind, f.size, f.ea);
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

    /* Hook mode: the hook runs before the exit with the exact fault tuple,
     * for an unmapped access and for a write to a read-only region. */
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

    const wantHookRo = permLine(4, 0x00024000, "ro", REGION_RO, REGION_RO_SIZE);
    const hookRoRun = run(["hook-ro"]);
    const hookRoOut = lines(hookRoRun.stdout);
    const hookRoErr = lines(hookRoRun.stderr);
    if (
        hookRoRun.status !== 9 ||
        hookRoOut.join("|") !== "hook-set=1|hook 00024000 4 1" ||
        hookRoErr.length !== 1 ||
        hookRoErr[0] !== wantHookRo
    ) {
        failures.push({
            id: "hook-ro",
            detail: `exit ${hookRoRun.status}, stdout ${JSON.stringify(hookRoOut)}, stderr ${JSON.stringify(hookRoErr)}`,
        });
    }

    /* Determinism: the same fault twice is byte-identical on both streams. */
    const first = run(["fault", faults[0].id]);
    const second = run(["fault", faults[0].id]);
    if (first.status !== second.status || first.stdout !== second.stdout || first.stderr !== second.stderr) {
        failures.push({ id: "determinism", detail: "two runs of the same fault differed" });
    }
    const permFirst = run(["fault", "write-to-readonly"]);
    const permSecond = run(["fault", "write-to-readonly"]);
    if (
        permFirst.status !== permSecond.status ||
        permFirst.stdout !== permSecond.stdout ||
        permFirst.stderr !== permSecond.stderr
    ) {
        failures.push({ id: "determinism-readonly", detail: "two runs of the read-only fault differed" });
    }

    return {
        basicLines: lines(basicRun.stdout).length,
        hleLines: lines(hleRun.stdout).length,
        rawLines: lines(rawRun.stdout).length,
        faultCases: faults.length,
        hleFaultCases: hleFaults.length,
        failures,
    };
}

function runMem(opts = {}) {
    const compiler = opts.compiler !== undefined ? opts.compiler : findCompiler();
    if (!compiler) return { compiler: null, basicLines: 0, hleLines: 0, rawLines: 0, faultCases: 0, hleFaultCases: 0, failures: [], skipped: true };
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
        `mem: basic ${res.basicLines} lines, HLE ${res.hleLines} lines, raw ${res.rawLines} lines, ` +
            `${res.faultCases} fault cases, ${res.hleFaultCases} HLE fault cases, hook and determinism checks, ` +
            `compiled with ${res.compiler}`
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
