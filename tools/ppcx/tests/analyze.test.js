"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeRpx } = require("../lib/analyze.js");

const BASE = 0x1000;
const TEXT_OFFSET = 0x40;
const TEXT_SIZE = 0x1008; // 0x1000..0x2008

function buildFixture() {
    const data = Buffer.alloc(TEXT_SIZE);
    const put = (addr, word) => data.writeUInt32BE(word >>> 0, addr - BASE);
    put(0x1000, 0x9421fff0); // stwu r1, -16(r1): function start at the base
    put(0x1004, 0x60000000); // nop
    put(0x1008, 0x4e800020); // blr: boundary
    put(0x100c, 0x7c0802a6); // mflr r0: prologue after a boundary
    put(0x1010, 0x48000ff1); // bl 0x2000
    put(0x1014, 0x4e800020); // blr
    put(0x2000, 0x4e800020); // blr: start discovered from the bl target
    put(0x2004, 0x60000000); // nop
    for (let addr = 0x1018; addr < 0x2000; addr += 4) put(addr, 0x60000000);
    const buf = Buffer.alloc(TEXT_OFFSET + TEXT_SIZE);
    data.copy(buf, TEXT_OFFSET);
    const parsed = {
        sections: [
            {
                index: 1,
                name: ".text",
                type: 1, // SHT_PROGBITS
                flags: 0x4, // SHF_EXECINSTR
                addr: BASE,
                offset: TEXT_OFFSET,
                size: TEXT_SIZE,
                logicalSize: TEXT_SIZE,
                entsize: 0,
            },
        ],
    };
    return { buf, parsed };
}

test("discovers function starts from bl targets and prologues", () => {
    const { buf, parsed } = buildFixture();
    const a = analyzeRpx(buf, parsed);
    assert.equal(a.base, BASE);
    assert.equal(a.size, TEXT_SIZE);
    assert.deepEqual(a.functionStarts, [0x1000, 0x100c, 0x2000]);
    assert.equal(a.functionCount, 3);
    assert.equal(a.stats.blTargetsInText, 1);
    assert.equal(a.stats.blTargetsOutsideText, 0);
    assert.equal(a.stats.fullySupportedFunctions, 3);
    // No .rodata in the fixture: no pointer-derived starts.
    assert.deepEqual(a.pointerStarts, []);
    assert.equal(a.stats.pointerStartsTotal, 0);
});

test("reports full coverage on an all-supported fixture", () => {
    const { buf, parsed } = buildFixture();
    const a = analyzeRpx(buf, parsed);
    assert.equal(a.words, TEXT_SIZE / 4);
    assert.equal(a.coverage.supported, TEXT_SIZE / 4);
    assert.equal(a.coverage.unsupported, 0);
    assert.equal(a.coverage.unknown, 0);
    assert.equal(a.coverage.topUnsupported.length, 0);
});

test("counts unsupported and unknown words", () => {
    const { buf, parsed } = buildFixture();
    // fctid at 0x1004 (known but unsupported), op 2 at 0x1008 (unknown) and
    // an implemented psq_l at 0x100C (counts as supported).
    buf.writeUInt32BE(0xfc00065c, TEXT_OFFSET + 4);
    buf.writeUInt32BE(0x08000000, TEXT_OFFSET + 8);
    buf.writeUInt32BE(((56 << 26) | (1 << 21)) >>> 0, TEXT_OFFSET + 12);
    const a = analyzeRpx(buf, parsed);
    assert.equal(a.coverage.unsupported, 1);
    assert.equal(a.coverage.unknown, 1);
    assert.equal(a.coverage.supported, TEXT_SIZE / 4 - 2);
    const top = new Map(a.coverage.topUnsupported);
    assert.equal(top.get("fctid"), 1);
});

test("accepts a custom text section name", () => {
    const { buf, parsed } = buildFixture();
    const b = analyzeRpx(buf, parsed, { textSection: ".text" });
    assert.equal(b.section, ".text");
    assert.throws(() => analyzeRpx(buf, parsed, { textSection: ".missing" }), /not found/);
});

function buildPointerFixture() {
    const { buf, parsed } = buildFixture();
    // Layout after .text (ends at 0x1048): .rodata (8), .rela.rodata (12),
    // .data (8), .rela.data (two 12-byte relocation records).
    const RODATA_OFF = 0x1048;
    const RELA_RODATA_OFF = 0x1050;
    const DATA_OFF = 0x105c;
    const RELA_DATA_OFF = 0x1064;
    const RELA_DATA_SIZE = 24;
    const big = Buffer.alloc(RELA_DATA_OFF + RELA_DATA_SIZE);
    buf.copy(big, 0);
    // .rodata holds one code pointer (0x1010, not a branch-derived start).
    big.writeUInt32BE(0x1010, RODATA_OFF);
    big.writeUInt32BE(0x5000, RELA_RODATA_OFF); // r_offset
    big.writeUInt32BE(1, RELA_RODATA_OFF + 4); // r_info: R_PPC_ADDR32
    big.writeUInt32BE(0x1010, RELA_RODATA_OFF + 8); // r_addend
    // .data holds an ADDR32 pointer (0x2004) plus a non-ADDR32 word whose
    // raw value also looks like a pointer and must be ignored.
    big.writeUInt32BE(0x2004, DATA_OFF);
    big.writeUInt32BE(0x1014, DATA_OFF + 4);
    big.writeUInt32BE(0x6000, RELA_DATA_OFF); // r_offset
    big.writeUInt32BE(1, RELA_DATA_OFF + 4); // r_info: R_PPC_ADDR32
    big.writeUInt32BE(0x2004, RELA_DATA_OFF + 8); // r_addend
    big.writeUInt32BE(0x6004, RELA_DATA_OFF + 12); // r_offset
    big.writeUInt32BE(2, RELA_DATA_OFF + 16); // r_info: R_PPC_ADDR16_HA, ignored
    big.writeUInt32BE(0x1014, RELA_DATA_OFF + 20); // r_addend
    parsed.sections.push(
        {
            index: 2,
            name: ".rodata",
            type: 1,
            flags: 0x2,
            addr: 0x5000,
            offset: RODATA_OFF,
            size: 8,
            logicalSize: 8,
            entsize: 0,
        },
        {
            index: 3,
            name: ".rela.rodata",
            type: 4,
            flags: 0,
            addr: 0,
            offset: RELA_RODATA_OFF,
            size: 12,
            logicalSize: 12,
            entsize: 12,
        },
        {
            index: 4,
            name: ".data",
            type: 1,
            flags: 0x3,
            addr: 0x6000,
            offset: DATA_OFF,
            size: 8,
            logicalSize: 8,
            entsize: 0,
        },
        {
            index: 5,
            name: ".rela.data",
            type: 4,
            flags: 0,
            addr: 0,
            offset: RELA_DATA_OFF,
            size: RELA_DATA_SIZE,
            logicalSize: RELA_DATA_SIZE,
            entsize: 12,
        },
    );
    return { buf: big, parsed };
}

test("collects code pointers from .rela.rodata and .rela.data only when ADDR32", () => {
    const { buf, parsed } = buildPointerFixture();
    const a = analyzeRpx(buf, parsed);
    assert.deepEqual(a.pointerStarts, [0x1010, 0x2004]);
    assert.equal(a.stats.pointerStartsTotal, 2);
    assert.equal(a.stats.pointerStartsExtra, 2);
    // The non-ADDR32 .data word is not promoted, and branch starts are
    // unchanged by the pointer scan.
    assert.deepEqual(a.functionStarts, [0x1000, 0x100c, 0x2000]);
});

function buildTailFixture() {
    const { buf, parsed } = buildFixture();
    const put = (addr, word) => buf.writeUInt32BE(word >>> 0, addr - BASE + TEXT_OFFSET);
    put(0x1004, 0x48000100); // b 0x1104: crosses the range, adds 0x1104
    put(0x1100, 0x48000100); // b 0x1200: intra-range until 0x1104 splits it
    put(0x1400, 0x48000100); // b 0x1500: intra-range, must stay out
    return { buf, parsed };
}

test("adds cross-range tail targets to the start set to a fixpoint", () => {
    const { buf, parsed } = buildTailFixture();
    const a = analyzeRpx(buf, parsed);
    // 0x1104 is a direct cross-range target; adding it splits the range and
    // exposes 0x1200 as the second-order cross-range target. 0x1500 stays a
    // plain intra-range goto.
    assert.deepEqual(a.tailStarts, [0x1104, 0x1200]);
    assert.equal(a.stats.tailStartsAdded, 2);
    assert.ok(!a.tailStarts.includes(0x1500));
    // Tail targets never re-classify branch starts or pointer starts.
    assert.deepEqual(a.functionStarts, [0x1000, 0x100c, 0x2000]);
    assert.deepEqual(a.pointerStarts, []);
});
