"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { compareDumps, normalize } = require("../lib/xcheck.js");

/* A synthetic 9-word image compared against three dump files of four words. */
const x = (xo, rt, ra, rb) => ((31 << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1)) >>> 0;
const addi = (rt, ra, imm) => ((14 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0;
const or_ = (ra, rs, rb, rc) => ((31 << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (444 << 1) | (rc ? 1 : 0)) >>> 0;
const psqL = (frd, ra, d) => ((56 << 26) | (frd << 21) | (ra << 16) | (d & 0xfff)) >>> 0;

const words = [
    x(279, 3, 4, 5), // lhzx            -> equal
    addi(3, 4, 0), //   addi            -> alias (li)
    or_(3, 4, 4, true), // or.          -> alias (mr.)
    0x60000000, //      nop             -> equal
    0x00000000, //      invalid-0       -> undecoded (both sides refuse)
    x(375, 3, 4, 5), // lhaux           -> rizinInvalid (rizin's CPU model refuses it)
    psqL(3, 4, 0), //   psq_l           -> overlap (rizin reads the VSX encoding)
    0x80640000, //      lwz             -> missing line
    addi(3, 4, 0), //   addi            -> mismatch (rizin says lwz)
];
const text = Buffer.alloc(words.length * 4);
words.forEach((w, i) => text.writeUInt32BE(w >>> 0, i * 4));

const dumps = [
    {
        name: "rizin-000.txt",
        text: [
            "0x00000000      lhzx  r3, r4, r5",
            "0x00000004      li    r3, 0",
            "0x00000008      mr.   r3, r4",
            "0x0000000c      nop",
            "0x00000004      stw   r0, 0(r1)", // duplicate: ignored (first line wins)
            "0x00000020      lwz   r3, 0(r4)", // outside this file's range: ignored
            "  continuation fragment", // wrapped line: ignored
        ].join("\n"),
    },
    {
        name: "rizin-001.txt",
        text: [
            "0x00000010      invalid",
            "0x00000014      invalid",
            "0x00000018      vextdubvlx r3, r4, r5",
        ].join("\n"),
    },
    {
        name: "rizin-002.txt",
        text: ["0x00000020      lwz   r3, 0(r4)"].join("\n"),
    },
];

test("buckets every comparison class and ignores stale dump lines", () => {
    const report = compareDumps({ text, dumps, chunk: 4 });

    assert.equal(report.counts.words, 9);
    assert.equal(report.counts.equal, 2); // lhzx, nop
    assert.equal(report.counts.alias, 2); // li, mr.
    assert.equal(report.counts.overlap, 1); // psq_l vs vextdubvlx
    assert.equal(report.counts.suffixMismatch, 0);
    assert.equal(report.counts.undecoded, 1); // invalid-0
    assert.equal(report.counts.rizinInvalid, 1); // lhaux
    assert.equal(report.counts.missing, 1); // word 7 has no line
    assert.equal(report.counts.mismatch, 1); // word 8: addi vs lwz

    assert.equal(report.parse.duplicates, 1);
    assert.equal(report.parse.outOfRange, 1);
    assert.equal(report.parse.continuations, 1);

    assert.equal(report.classes.mismatch[0].cls, "addi => lwz");
    assert.equal(report.classes.alias[0].cls, "addi => li");
    assert.equal(report.classes.overlap[0].cls, "psq_l => vextdubvlx");
    assert.equal(report.classes.undecoded[0].cls, "invalid-0 => invalid");
    assert.equal(report.classes.rizinInvalid[0].cls, "lhaux => invalid");
});

test("normalize keeps the record suffix and resolves aliases", () => {
    assert.deepEqual(normalize("clrlwi."), { base: "rlwinm", dot: "." });
    assert.deepEqual(normalize("rlwinm"), { base: "rlwinm", dot: "" });
    assert.deepEqual(normalize("lhzux"), { base: "lhzux", dot: "" });
    assert.deepEqual(normalize("twu"), { base: "tw", dot: "" });
});
