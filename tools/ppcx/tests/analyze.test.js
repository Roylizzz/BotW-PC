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
