"use strict";

/**
 * Guest programs for the ISA harness.
 *
 * Each case is a tiny program (a single basic block ending in `blr`) plus an
 * initial CPU and memory state. tests/isa/run.js translates each program with
 * the real translator, compiles and runs it, and compares the resulting state
 * against tests/isa/oracle.js.
 *
 * The cases target the instruction semantics that were changed or fixed
 * during the 2026-10 audit, plus the arithmetic corners the audit marked as
 * acceptance criteria.
 */

/* ------------------------------------------------------------------ */
/* Minimal assembler (encodings straight from the ISA tables)          */
/* ------------------------------------------------------------------ */

const BLR = 0x4e800020;

const A = {
    addi: (rt, ra, imm) => ((14 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    addis: (rt, ra, imm) => ((15 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    addic: (rt, ra, imm) => ((12 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    addic_: (rt, ra, imm) => ((13 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    subfic: (rt, ra, imm) => ((8 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    mulli: (rt, ra, imm) => ((7 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    cmpi: (crf, ra, imm) => ((11 << 26) | (crf << 23) | (ra << 16) | (imm & 0xffff)) >>> 0,
    cmpli: (crf, ra, imm) => ((10 << 26) | (crf << 23) | (ra << 16) | (imm & 0xffff)) >>> 0,
    ori: (ra, rs, imm) => ((24 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    oris: (ra, rs, imm) => ((25 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    xori: (ra, rs, imm) => ((26 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    xoris: (ra, rs, imm) => ((27 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    andi_: (ra, rs, imm) => ((28 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    andis_: (ra, rs, imm) => ((29 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,

    lwz: (rt, ra, imm) => ((32 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    lwzu: (rt, ra, imm) => ((33 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    lbz: (rt, ra, imm) => ((34 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    stw: (rs, ra, imm) => ((36 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    stwu: (rs, ra, imm) => ((37 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    stb: (rs, ra, imm) => ((38 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    stbu: (rs, ra, imm) => ((39 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    lhz: (rt, ra, imm) => ((40 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    lha: (rt, ra, imm) => ((42 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    sth: (rs, ra, imm) => ((44 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    sthu: (rs, ra, imm) => ((45 << 26) | (rs << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    lmw: (rt, ra, imm) => ((46 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,
    stmw: (rt, ra, imm) => ((47 << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0,

    rlwinm: (ra, rs, sh, mb, me, rc) =>
        ((21 << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1) | (rc ? 1 : 0)) >>> 0,
    rlwimi: (ra, rs, sh, mb, me, rc) =>
        ((20 << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1) | (rc ? 1 : 0)) >>> 0,
    rlwnm: (ra, rs, rb, mb, me, rc) =>
        ((23 << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (mb << 6) | (me << 1) | (rc ? 1 : 0)) >>> 0,

    /* X-form (no OE field) */
    x: (xo, rt, ra, rb, rc) => ((31 << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1) | (rc ? 1 : 0)) >>> 0,
    /* XO-form (OE at bit 10) */
    xo: (xo, rt, ra, rb, oe, rc) =>
        ((31 << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1) | (oe ? 1 << 10 : 0) | (rc ? 1 : 0)) >>> 0,
    srawi: (ra, rs, sh, rc) => ((31 << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (824 << 1) | (rc ? 1 : 0)) >>> 0,
    lswi: (rt, ra, nb) => ((31 << 26) | (rt << 21) | (ra << 16) | (nb << 11) | (597 << 1)) >>> 0,
    stswi: (rs, ra, nb) => ((31 << 26) | (rs << 21) | (ra << 16) | (nb << 11) | (725 << 1)) >>> 0,
    lwarx: (rt, ra, rb) => ((31 << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (20 << 1)) >>> 0,
    stwcx_: (rs, ra, rb) => ((31 << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (150 << 1)) >>> 0,
    mfspr: (rt, spr) => ((31 << 26) | (rt << 21) | (((spr >>> 5) & 0x1f) << 16) | ((spr & 0x1f) << 11) | (339 << 1)) >>> 0,
    mtspr: (spr, rs) => ((31 << 26) | (rs << 21) | (((spr >>> 5) & 0x1f) << 16) | ((spr & 0x1f) << 11) | (467 << 1)) >>> 0,
    mfcr: (rt) => ((31 << 26) | (rt << 21) | (19 << 1)) >>> 0,
    mtcrf: (fm, rs) => ((31 << 26) | (rs << 21) | (fm << 12) | (144 << 1)) >>> 0,
    dcbz: (ra, rb) => ((31 << 26) | (ra << 16) | (rb << 11) | (1014 << 1)) >>> 0,
    tw: (to, ra, rb) => ((31 << 26) | (to << 21) | (ra << 16) | (rb << 11) | (4 << 1)) >>> 0,

    /* PSQ: D-form (12-bit displacement) and indexed X-form (sub-opcode in
     * bits 25..30, W/I in bits 21..24). */
    psq_l: (frd, ra, d, w, i) => ((56 << 26) | (frd << 21) | (ra << 16) | (w << 15) | (i << 12) | (d & 0xfff)) >>> 0,
    psq_lu: (frd, ra, d, w, i) => ((57 << 26) | (frd << 21) | (ra << 16) | (w << 15) | (i << 12) | (d & 0xfff)) >>> 0,
    psq_st: (frs, ra, d, w, i) => ((60 << 26) | (frs << 21) | (ra << 16) | (w << 15) | (i << 12) | (d & 0xfff)) >>> 0,
    psq_stu: (frs, ra, d, w, i) => ((61 << 26) | (frs << 21) | (ra << 16) | (w << 15) | (i << 12) | (d & 0xfff)) >>> 0,
    psq_lx: (frd, ra, rb, w, i) => ((4 << 26) | (frd << 21) | (ra << 16) | (rb << 11) | (w << 10) | (i << 7) | (6 << 1)) >>> 0,
    psq_stx: (frs, ra, rb, w, i) => ((4 << 26) | (frs << 21) | (ra << 16) | (rb << 11) | (w << 10) | (i << 7) | (7 << 1)) >>> 0,
    psq_lux: (frd, ra, rb, w, i) => ((4 << 26) | (frd << 21) | (ra << 16) | (rb << 11) | (w << 10) | (i << 7) | (38 << 1)) >>> 0,
    psq_stux: (frs, ra, rb, w, i) => ((4 << 26) | (frs << 21) | (ra << 16) | (rb << 11) | (w << 10) | (i << 7) | (39 << 1)) >>> 0,

    sync: 0x7c0004ac,
    lwsync: 0x7c2004ac,
    eieio: 0x7c0006ac,
    isync: 0x4c00012c,
    blr: BLR,
};

/* Logical and shift instructions put the destination in the rA field and the
 * source in the rS (= RT) field; these wrappers make the cases readable. */
A.logical = (xo, ra, rs, rb, rc) => A.xo(xo, rs, ra, rb, false, rc);
A.unary = (xo, ra, rs, rc) => A.xo(xo, rs, ra, rs, false, rc);

const X31 = {
    add: 266, addc: 10, adde: 138, addme: 234, addze: 202,
    subf: 40, subfc: 8, subfe: 136, subfme: 232, subfze: 200,
    neg: 104, mullw: 235, mulhw: 75, mulhwu: 11, divw: 491, divwu: 459,
    and: 28, andc: 60, or: 444, orc: 412, xor: 316, nand: 476, nor: 124, eqv: 284,
    slw: 24, srw: 536, sraw: 792, cntlzw: 26, extsb: 954, extsh: 922,
    cmp: 0, cmpl: 32,
};

const hex = (v) => `0x${(v >>> 0).toString(16).padStart(8, "0")}`;
const MEM = 0x2000;
const bytes = (...list) => list.map((b) => b.toString(16).padStart(2, "0")).join("");

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

function buildCases() {
    const cases = [];
    let next = 0;
    const add = (name, prog, init = {}, mem = [], dump = []) => {
        cases.push({ id: next++, name, prog, init, mem, dump });
    };

    /* --- rotate-and-mask: the mask construction, all corners --- */
    const maskPairs = [
        [0, 0], [0, 1], [1, 0], [31, 31], [31, 30], [30, 31], [0, 31], [31, 0],
        [5, 10], [10, 5], [16, 15], [15, 16], [8, 4], [4, 8], [23, 31], [24, 8],
        [12, 20], [20, 12], [19, 13], [13, 19], [2, 29], [29, 2], [7, 7], [17, 16],
        [15, 15],
    ];
    for (const [mb, me] of maskPairs) {
        for (const v of [0xffffffff, 0x12345678, 0x80000001]) {
            add(
                `rlwinm mb=${mb} me=${me} v=${hex(v)}`,
                [A.rlwinm(3, 4, 13, mb, me, false), A.blr],
                { gpr: { 4: v } }
            );
        }
    }
    for (const [mb, me] of [[0, 31], [31, 0], [6, 25], [13, 13]]) {
        for (const sh of [0, 31]) {
            add(
                `rlwinm sh=${sh} mb=${mb} me=${me}`,
                [A.rlwinm(3, 4, sh, mb, me, false), A.blr],
                { gpr: { 4: 0xa5a5a5a5 } }
            );
        }
    }
    for (const [mb, me] of [[0, 7], [7, 0], [16, 31]]) {
        add(
            `rlwimi mb=${mb} me=${me}`,
            [A.rlwimi(3, 4, 8, mb, me, false), A.blr],
            { gpr: { 3: 0xa5a5a5a5, 4: 0x5a5a5a5a } }
        );
    }
    for (const sh of [0, 1, 31, 32, 33]) {
        add(
            `rlwnm shift=${sh}`,
            [A.rlwnm(3, 4, 5, 4, 27, false), A.blr],
            { gpr: { 4: 0x80000001, 5: sh } }
        );
    }

    /* --- D-form: RA = 0 means 0 for addi/addis, r0 for the rest --- */
    add("addi r0 literal", [A.addi(3, 0, 5), A.blr], { gpr: { 0: 0xdeadbeef } });
    add("addi negative", [A.addi(3, 4, -1), A.blr], { gpr: { 4: 0 } });
    add("addis r0 literal", [A.addis(3, 0, 1), A.blr], { gpr: { 0: 0xdeadbeef } });
    add("addis with rA", [A.addis(3, 4, 0x7fff), A.blr], { gpr: { 4: 0x80000000 } });
    add("addic reads r0", [A.addic(3, 0, 1), A.blr], { gpr: { 0: 0xffffffff }, xer: 0xa0000000 });
    add("addic. reads r0 (CR0)", [A.addic_(3, 0, 0), A.blr], { gpr: { 0: 0x80000000 }, cr: 0x12345678 });
    add("addic. SO propagates", [A.addic_(3, 0, 0), A.blr], { gpr: { 0: 0x80000000 }, xer: 0x80000000 });
    add("subfic reads r0", [A.subfic(3, 0, 10), A.blr], { gpr: { 0: 3 }, xer: 0xa0000000 });
    add("subfic wraps", [A.subfic(3, 4, 0), A.blr], { gpr: { 4: 0x80000000 } });
    add("mulli negative multiplier", [A.mulli(3, 4, -1), A.blr], { gpr: { 4: 5 }, cr: 0x12345678 });
    add("mulli reads r0", [A.mulli(3, 0, 0x7fff), A.blr], { gpr: { 0: 0xffffffff } });
    add("cmpi signed less", [A.cmpi(1, 0, -1), A.blr], { gpr: { 0: 0xdeadbeef } });
    add("cmpi equal with SO", [A.cmpi(2, 0, -1), A.blr], { gpr: { 0: 0xffffffff }, xer: 0x80000000 });
    add("cmpli unsigned 0xffff", [A.cmpli(1, 0, 0xffff), A.blr], { gpr: { 0: 0x0000ffff }, xer: 0x80000000 });
    add("cmpli unsigned greater", [A.cmpli(3, 0, 0xffff), A.blr], { gpr: { 0: 0x00010000 } });
    add(
        "logical immediates",
        [A.ori(3, 4, 0xf0f0), A.oris(5, 4, 0x1234), A.xori(6, 4, 0xffff), A.xoris(7, 4, 0xaaaa), A.blr],
        { gpr: { 4: 0x12345678 } }
    );
    add(
        "andi./andis. update CR0",
        [A.andi_(3, 4, 0xff00), A.andis_(5, 4, 0xff00), A.blr],
        { gpr: { 4: 0xff00ff00 } }
    );

    /* --- memory --- */
    add(
        "stw/lwz/lha/lhz/lbz big-endian",
        [
            A.stw(5, 0, MEM),
            A.lwz(3, 0, MEM),
            A.lha(6, 0, MEM + 2),
            A.lhz(7, 0, MEM + 2),
            A.lbz(8, 0, MEM + 3),
            A.blr,
        ],
        { gpr: { 5: 0x11223344 } },
        [{ addr: MEM + 2, hex: bytes(0x80, 0x01) }],
        [{ addr: MEM, len: 8 }]
    );
    add(
        "stbu/sthu update the base register",
        [A.addi(1, 0, MEM), A.stb(5, 1, 1), A.sthu(6, 1, 2), A.blr],
        { gpr: { 5: 0xab, 6: 0xcdef } },
        [{ addr: MEM, hex: bytes(0, 0, 0, 0, 0, 0, 0, 0) }],
        [{ addr: MEM, len: 8 }]
    );
    add(
        "lwzu updates rt when rt = ra",
        [A.addi(3, 0, MEM), A.lwzu(3, 3, 4), A.blr],
        {},
        [{ addr: MEM + 4, hex: bytes(0xca, 0xfe, 0xba, 0xbe) }]
    );
    /* Halfword indexed loads: lhzx (279), lhzux (311), lhax (343), lhaux
     * (375). 0x8080 in memory separates zero- from sign-extension, the update
     * forms write rA with the effective address first — a load into rA keeps
     * the loaded value. */
    const hw = [{ addr: MEM, hex: bytes(0x80, 0x80, 0x7f, 0x7f) }];
    add("lhzx zero-extends", [A.addi(4, 0, MEM), A.addi(5, 0, 0), A.x(279, 3, 4, 5), A.blr], {}, hw);
    add(
        "lhzux zero-extends and updates rA",
        [A.addi(4, 0, MEM + 2), A.addi(5, 0, -2), A.x(311, 3, 4, 5), A.blr],
        {},
        hw
    );
    add("lhax sign-extends", [A.addi(4, 0, MEM), A.addi(5, 0, 0), A.x(343, 3, 4, 5), A.blr], {}, hw);
    add(
        "lhaux sign-extends and updates rA",
        [A.addi(4, 0, MEM + 2), A.addi(5, 0, -2), A.x(375, 3, 4, 5), A.blr],
        {},
        hw
    );
    add(
        "lhaux with rT = rA keeps the loaded value",
        [A.addi(4, 0, MEM), A.addi(5, 0, 0), A.x(375, 4, 4, 5), A.blr],
        {},
        hw
    );
    add(
        "stwu stores the old base first",
        [A.addi(1, 0, MEM + 16), A.stwu(1, 1, -16), A.blr],
        {}, [], [{ addr: MEM, len: 4 }]
    );
    add(
        "lmw loads through r31",
        [A.addi(6, 0, MEM), A.lmw(5, 6, 0), A.blr],
        {},
        [{ addr: MEM, hex: bytes(1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4) }]
    );
    add(
        "lmw with ra in range",
        [A.addi(6, 0, MEM), A.lmw(6, 6, 0), A.blr],
        {},
        [{ addr: MEM, hex: bytes(0xaa, 0, 0, 0, 0xbb, 0, 0, 0, 0xcc, 0, 0, 0, 0xdd, 0, 0, 0) }]
    );
    add(
        "stmw stores through r31",
        [A.addi(6, 0, MEM), A.stmw(5, 6, 0), A.blr],
        { gpr: { 5: 0x11111111, 6: 0x22222222, 7: 0x33333333, 8: 0x44444444 } },
        [], [{ addr: MEM, len: 16 }]
    );

    /* --- XO-form arithmetic, carry chains and overflow --- */
    add("add keeps CR0", [A.xo(X31.add, 3, 4, 5), A.blr], { gpr: { 4: 1, 5: 2 }, cr: 0xdeadbeef });
    add("add. updates CR0", [A.xo(X31.add, 3, 4, 5, false, true), A.blr], { gpr: { 4: 1, 5: 2 }, cr: 0xdeadbeef });
    add("addo overflow", [A.xo(X31.add, 3, 4, 5, true, false), A.blr], { gpr: { 4: 0x7fffffff, 5: 1 } });
    add("addo no overflow, SO sticky", [A.xo(X31.add, 3, 4, 5, true, false), A.blr], { gpr: { 4: 1, 5: 2 }, xer: 0x80000000 });
    add("addo overflow, rT aliases rA", [A.xo(X31.add, 3, 3, 4, true, false), A.blr], { gpr: { 3: 0x7fffffff, 4: 1 } });
    add("addo overflow, rT aliases rB", [A.xo(X31.add, 3, 4, 3, true, false), A.blr], { gpr: { 3: 0x80000000, 4: 0x80000000 } });
    add("addc carry out", [A.xo(X31.addc, 3, 4, 5), A.blr], { gpr: { 4: 0xffffffff, 5: 1 }, xer: 0xa0000000 });
    add("addco overflow", [A.xo(X31.addc, 3, 4, 5, true, false), A.blr], { gpr: { 4: 0x7fffffff, 5: 1 } });
    add("addco overflow, rT aliases rA", [A.xo(X31.addc, 3, 3, 4, true, false), A.blr], { gpr: { 3: 0x7fffffff, 4: 0x7fffffff } });
    add("adde with carry in", [A.xo(X31.adde, 3, 4, 5), A.blr], { gpr: { 4: 0xffffffff, 5: 0 }, xer: 0x20000000 });
    add("adde without carry in", [A.xo(X31.adde, 3, 4, 5), A.blr], { gpr: { 4: 0xffffffff, 5: 0 }, xer: 0x40000000 });
    add("addme with carry in", [A.xo(X31.addme, 3, 4, 4), A.blr], { gpr: { 4: 1 }, xer: 0x20000000 });
    add("addmeo overflow", [A.xo(X31.addme, 3, 4, 4, true, false), A.blr], { gpr: { 4: 0x80000000 } });
    add("addmeo overflow, rT aliases rA", [A.xo(X31.addme, 3, 3, 4, true, false), A.blr], { gpr: { 3: 0x80000000 } });
    add("addze with carry in", [A.xo(X31.addze, 3, 4, 4), A.blr], { gpr: { 4: 0xffffffff }, xer: 0x20000000 });
    add("addzeo no overflow", [A.xo(X31.addze, 3, 4, 4, true, false), A.blr], { gpr: { 4: 1 }, xer: 0x20000000 });
    add("subf drops carry", [A.xo(X31.subf, 3, 4, 5), A.blr], { gpr: { 4: 1, 5: 0 }, xer: 0x20000000 });
    add("subfo overflow", [A.xo(X31.subf, 3, 4, 5, true, false), A.blr], { gpr: { 4: 0x80000000, 5: 1 } });
    add("subfo no overflow, rT aliases rA", [A.xo(X31.subf, 3, 3, 4, true, false), A.blr], { gpr: { 3: 0x80000000, 4: 0x80000000 } });
    add("subfc borrow", [A.xo(X31.subfc, 3, 4, 5), A.blr], { gpr: { 4: 1, 5: 0 }, xer: 0x20000000 });
    add("subfc carry out", [A.xo(X31.subfc, 3, 4, 5), A.blr], { gpr: { 4: 0, 5: 5 } });
    add("subfe with carry in", [A.xo(X31.subfe, 3, 4, 5), A.blr], { gpr: { 4: 1, 5: 1 }, xer: 0x20000000 });
    add("subfe without carry in", [A.xo(X31.subfe, 3, 4, 5), A.blr], { gpr: { 4: 1, 5: 1 } });
    add("subfme", [A.xo(X31.subfme, 3, 4, 4), A.blr], { gpr: { 4: 0 } });
    add("subfze", [A.xo(X31.subfze, 3, 4, 4), A.blr], { gpr: { 4: 0 }, xer: 0x20000000 });
    add("neg leaves CA", [A.xo(X31.neg, 3, 4, 4), A.blr], { gpr: { 4: 0x80000000 }, xer: 0x20000000 });
    add("nego overflow", [A.xo(X31.neg, 3, 4, 4, true, false), A.blr], { gpr: { 4: 0x80000000 } });
    add("nego overflow, rT aliases rA", [A.xo(X31.neg, 3, 3, 4, true, false), A.blr], { gpr: { 3: 0x80000000 } });
    add("nego no overflow", [A.xo(X31.neg, 3, 4, 4, true, false), A.blr], { gpr: { 4: 1 } });
    add("neg. updates CR0", [A.xo(X31.neg, 3, 4, 4, false, true), A.blr], { gpr: { 4: 1 }, cr: 0xdeadbeef });
    add("mullw keeps CR0 and OV", [A.xo(X31.mullw, 3, 4, 5), A.blr], { gpr: { 4: 3, 5: 5 }, cr: 0xdeadbeef, xer: 0x40000000 });
    add("mullw. updates CR0", [A.xo(X31.mullw, 3, 4, 5, false, true), A.blr], { gpr: { 4: 3, 5: 5 }, cr: 0xdeadbeef });
    add("mullwo overflow", [A.xo(X31.mullw, 3, 4, 5, true, false), A.blr], { gpr: { 4: 0x40000000, 5: 4 } });
    add("mullwo no overflow", [A.xo(X31.mullw, 3, 4, 5, true, false), A.blr], { gpr: { 4: 3, 5: 5 }, xer: 0x80000000 });
    add("mulhw negative", [A.xo(X31.mulhw, 3, 4, 5), A.blr], { gpr: { 4: 0xffffffff, 5: 2 } });
    add("mulhwu", [A.xo(X31.mulhwu, 3, 4, 5), A.blr], { gpr: { 4: 0xffffffff, 5: 2 } });
    add("divw", [A.xo(X31.divw, 3, 4, 5), A.blr], { gpr: { 4: 7, 5: 2 } });
    add("divw negative truncates toward zero", [A.xo(X31.divw, 3, 4, 5), A.blr], { gpr: { 4: 0xfffffff9, 5: 2 } });
    add("divw by zero, OV untouched", [A.xo(X31.divw, 3, 4, 5), A.blr], { gpr: { 4: 5, 5: 0 }, xer: 0x40000000 });
    add("divwo by zero", [A.xo(X31.divw, 3, 4, 5, true, false), A.blr], { gpr: { 4: 5, 5: 0 } });
    add("divwo by zero negative dividend", [A.xo(X31.divw, 3, 4, 5, true, false), A.blr], { gpr: { 4: 0xfffffffb, 5: 0 } });
    add("divwo most negative", [A.xo(X31.divw, 3, 4, 5, true, false), A.blr], { gpr: { 4: 0x80000000, 5: 0xffffffff } });
    add("divwu", [A.xo(X31.divwu, 3, 4, 5), A.blr], { gpr: { 4: 7, 5: 2 } });
    add("divwu by zero", [A.xo(X31.divwu, 3, 4, 5), A.blr], { gpr: { 4: 5, 5: 0 } });
    add("divwuo by zero", [A.xo(X31.divwu, 3, 4, 5, true, false), A.blr], { gpr: { 4: 5, 5: 0 } });
    add("divwu large", [A.xo(X31.divwu, 3, 4, 5), A.blr], { gpr: { 4: 0xffffffff, 5: 2 } });

    /* --- logical / shift / unary --- */
    add(
        "logical ops keep CR0",
        [
            A.logical(X31.and, 3, 4, 5), A.logical(X31.andc, 6, 4, 5), A.logical(X31.or, 7, 4, 5),
            A.logical(X31.orc, 8, 4, 5), A.logical(X31.xor, 9, 4, 5), A.logical(X31.nand, 10, 4, 5),
            A.logical(X31.nor, 11, 4, 5), A.logical(X31.eqv, 12, 4, 5), A.blr,
        ],
        { gpr: { 4: 0xf0f0f0f0, 5: 0x12345678 }, cr: 0xdeadbeef }
    );
    add("and. updates only CR0", [A.logical(X31.and, 3, 4, 5, true), A.blr], { gpr: { 4: 0, 5: 0 }, cr: 0xdeadbeef });
    add(
        "shift counts over 31",
        [
            A.logical(X31.slw, 3, 4, 5), A.logical(X31.srw, 6, 4, 7),
            A.logical(X31.slw, 8, 4, 9), A.logical(X31.srw, 10, 4, 11),
            A.blr,
        ],
        { gpr: { 4: 0xffffffff, 5: 1, 7: 1, 9: 32, 11: 33 } }
    );
    add("srawi carry out", [A.srawi(3, 4, 1, false), A.blr], { gpr: { 4: 1 } });
    add("srawi negative carry", [A.srawi(3, 4, 1, false), A.blr], { gpr: { 4: 0xffffffff } });
    add("srawi sh=0 clears CA", [A.srawi(3, 4, 0, false), A.blr], { gpr: { 4: 1 }, xer: 0x20000000 });
    add("srawi sh=31", [A.srawi(3, 4, 31, false), A.blr], { gpr: { 4: 2 } });
    add("srawi. updates CR0", [A.srawi(3, 4, 1, true), A.blr], { gpr: { 4: 0xffffffff }, cr: 0xdeadbeef });
    add(
        "sraw shift amounts",
        [
            A.logical(X31.sraw, 3, 4, 5), A.logical(X31.sraw, 6, 4, 7),
            A.logical(X31.sraw, 8, 4, 9), A.logical(X31.sraw, 10, 4, 11),
            A.blr,
        ],
        { gpr: { 4: 0x80000000, 5: 1, 7: 32, 9: 33, 11: 0 } }
    );
    add(
        "cntlzw / extsb / extsh",
        [A.unary(X31.cntlzw, 3, 4), A.unary(X31.cntlzw, 5, 6), A.unary(X31.extsb, 7, 8), A.unary(X31.extsh, 9, 10), A.blr],
        { gpr: { 4: 0, 6: 1, 8: 0x80, 10: 0x8000 } }
    );

    /* --- compares and CR manipulation --- */
    add("cmp signed with SO", [A.xo(X31.cmp, 0, 4, 5, false, false), A.blr], { gpr: { 4: 0xffffffff, 5: 1 }, xer: 0x80000000 });
    add("cmpl equal", [A.xo(X31.cmpl, 0, 4, 5, false, false), A.blr], { gpr: { 4: 7, 5: 7 } });
    add("mtcrf/mfcr", [A.mtcrf(0x80, 4), A.mfcr(3), A.blr], { gpr: { 4: 0xdeadbeef }, cr: 0x12345678 });
    add(
        "mfspr/mtspr",
        [A.mfspr(3, 8), A.mtspr(9, 4), A.mfspr(5, 9), A.mfspr(6, 1), A.blr],
        { gpr: { 4: 0xdeadbeef }, lr: 0x12345678, xer: 0x20000000 }
    );

    /* --- string, reservation and cache --- */
    add(
        "stswi stores groups",
        [A.addi(1, 0, MEM), A.stswi(5, 1, 8), A.blr],
        { gpr: { 5: 0x11223344, 6: 0x55667788 } },
        [{ addr: MEM, hex: bytes(0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa) }],
        [{ addr: MEM, len: 8 }]
    );
    add(
        "lswi partial group zeroes",
        [A.addi(1, 0, MEM), A.lswi(5, 1, 6), A.blr],
        { gpr: { 5: 0xffffffff, 6: 0xffffffff } },
        [{ addr: MEM, hex: bytes(0x11, 0x22, 0x33, 0x44, 0x55, 0x66) }]
    );
    add(
        "lswi wraps r31 to r0",
        [A.addi(1, 0, MEM), A.lswi(31, 1, 8), A.blr],
        {},
        [{ addr: MEM, hex: bytes(0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88) }]
    );
    add(
        "stswi NB=0 stores 32 bytes",
        [A.addi(1, 0, MEM), A.stswi(5, 1, 0), A.blr],
        {
            gpr: {
                5: 0x11223344, 6: 0x22334455, 7: 0x33445566, 8: 0x44556677, 9: 0x55667788,
                10: 0x66778899, 11: 0x778899aa, 12: 0x8899aabb,
            },
        },
        [], [{ addr: MEM, len: 32 }]
    );
    add(
        "lswi NB=0 loads 32 bytes",
        [A.addi(1, 0, MEM), A.lswi(5, 1, 0), A.blr],
        {},
        [{
            addr: MEM,
            hex: bytes(
                0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
                0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10
            ),
        }]
    );
    add(
        "lwarx/stwcx. succeed",
        [A.addi(6, 0, MEM), A.lwarx(3, 0, 6), A.stwcx_(5, 0, 6), A.blr],
        { gpr: { 5: 0xcafebabe } },
        [{ addr: MEM, hex: bytes(1, 2, 3, 4) }],
        [{ addr: MEM, len: 4 }]
    );
    add(
        "stwcx. without reservation fails",
        [A.addi(6, 0, MEM), A.addi(7, 0, MEM + 16), A.lwarx(3, 0, 6), A.stwcx_(5, 0, 7), A.blr],
        { gpr: { 5: 0xcafebabe }, xer: 0x80000000 },
        [{ addr: MEM + 16, hex: bytes(9, 9, 9, 9) }],
        [{ addr: MEM + 16, len: 4 }]
    );
    add(
        "dcbz zeroes the aligned block",
        [A.addi(6, 0, MEM), A.dcbz(6, 7), A.blr],
        { gpr: { 7: 0x18 } },
        [{ addr: MEM, hex: bytes(...Array(64).fill(0xff)) }],
        [{ addr: MEM, len: 64 }]
    );
    add("fences keep state", [A.sync, A.lwsync, A.eieio, A.isync, A.blr], { cr: 0x12345678, xer: 0x20000000 });
    add("tw with a false condition continues", [A.tw(24, 0, 0), A.addi(3, 0, 1), A.blr], {});

    /* --- quantized paired-single load/store (GQR-driven) --- */
    const fbits = (bits) => [bits >>> 24, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff];

    add(
        "psq_l float pair",
        [A.psq_l(2, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM } },
        [{ addr: MEM, hex: bytes(...fbits(0x3f800000), ...fbits(0xbf800000)) }]
    );
    add(
        "psq_l float unpaired fills ps1 with 1.0",
        [A.psq_l(2, 4, 0, 1, 0), A.blr],
        { gpr: { 4: MEM } },
        [{ addr: MEM, hex: bytes(...fbits(0xc0000000)) }]
    );
    add(
        "psq_l float subnormal and negative zero",
        [A.psq_l(2, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM } },
        [{ addr: MEM, hex: bytes(...fbits(0x00000001), ...fbits(0x80000000)) }]
    );
    add(
        "psq_l float infinity and NaN",
        [A.psq_l(2, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM } },
        [{ addr: MEM, hex: bytes(...fbits(0x7f800000), ...fbits(0x7fc00001)) }]
    );
    add(
        "psq_l u8 pair",
        [A.psq_l(2, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: (4 << 16) | 4 } },
        [{ addr: MEM, hex: bytes(0x80, 0x7f) }]
    );
    add(
        "psq_l s8 pair",
        [A.psq_l(2, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: (6 << 16) | 6 } },
        [{ addr: MEM, hex: bytes(0x80, 0x7f) }]
    );
    add(
        "psq_l u16 pair",
        [A.psq_l(2, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: (5 << 16) | 5 } },
        [{ addr: MEM, hex: bytes(0x80, 0x01, 0x7f, 0xff) }]
    );
    add(
        "psq_l s16 pair",
        [A.psq_l(2, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: (7 << 16) | 7 } },
        [{ addr: MEM, hex: bytes(0x80, 0x01, 0x7f, 0xff) }]
    );
    add(
        "psq_l u8 unpaired",
        [A.psq_l(2, 4, 0, 1, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: (4 << 16) | 4 } },
        [{ addr: MEM, hex: bytes(0xc8) }]
    );
    add(
        "psq_l s16 unpaired with negative scale",
        [A.psq_l(2, 4, 0, 1, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: (7 << 16) | (62 << 24) } },
        [{ addr: MEM, hex: bytes(0x00, 0x10) }]
    );
    add(
        "psq_l s16 pair with positive scale",
        [A.psq_l(2, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: (7 << 16) | (3 << 24) } },
        [{ addr: MEM, hex: bytes(0x01, 0x00, 0xff, 0xfc) }]
    );
    add(
        "psq_l negative displacement",
        [A.addi(5, 0, MEM + 8), A.psq_l(2, 5, -8, 0, 0), A.blr],
        { gqr: { 0: (4 << 16) | 4 } },
        [{ addr: MEM, hex: bytes(0x11, 0x22) }]
    );
    add(
        "psq_l r0 base uses the literal displacement",
        [A.psq_l(2, 0, 0x100, 0, 0), A.blr],
        { gpr: { 0: 0xdeadbeef }, gqr: { 0: (4 << 16) | 4 } },
        [{ addr: 0x100, hex: bytes(0x2a, 0x2b) }]
    );
    add(
        "psq_lu updates rA and loads",
        [A.addi(5, 0, MEM + 4), A.psq_lu(2, 5, -4, 0, 0), A.blr],
        { gqr: { 0: (7 << 16) | 7 } },
        [{ addr: MEM, hex: bytes(0xff, 0xfe, 0x00, 0x02) }]
    );
    add(
        "psq_lu r0 base reads gpr0 and writes it back",
        [A.psq_lu(2, 0, -4, 0, 0), A.blr],
        { gpr: { 0: MEM + 4 }, gqr: { 0: (7 << 16) | 7 } },
        [{ addr: MEM, hex: bytes(0x00, 0x05, 0x00, 0x02) }]
    );
    add(
        "psq_lx indexed pair",
        [A.addi(4, 0, MEM), A.psq_lx(2, 4, 0, 0, 0), A.blr],
        { gqr: { 0: (7 << 16) | 7 } },
        [{ addr: MEM, hex: bytes(0xff, 0xfe, 0x00, 0x02) }]
    );
    add(
        "psq_lx rA = 0 uses rB",
        [A.addi(5, 0, MEM), A.psq_lx(2, 0, 5, 1, 0), A.blr],
        { gpr: { 0: 0xdeadbeef }, gqr: { 0: (7 << 16) | 7 } },
        [{ addr: MEM, hex: bytes(0x00, 0x40) }]
    );
    add(
        "psq_lux updates rA",
        [A.addi(4, 0, MEM + 2), A.addi(5, 0, -2), A.psq_lux(2, 4, 5, 0, 0), A.blr],
        { gqr: { 0: (7 << 16) | 7 } },
        [{ addr: MEM, hex: bytes(0x00, 0x03, 0xff, 0xfd) }]
    );
    add(
        "psq_l invalid type zeroes both lanes",
        [A.psq_l(5, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: 1 << 16 }, fpr: { 5: [0x3f800000, 0x3f800000] } },
        [{ addr: MEM, hex: bytes(0x11, 0x22, 0x33, 0x44) }]
    );
    add(
        "psq_l GQR index selects the register",
        [A.psq_l(2, 4, 0, 0, 0), A.psq_l(3, 4, 0, 0, 5), A.blr],
        { gpr: { 4: MEM }, gqr: { 5: (7 << 16) | 7 } },
        [{ addr: MEM, hex: bytes(0x3f, 0x80, 0x00, 0x00) }]
    );
    add(
        "psq_st float pair",
        [A.psq_st(3, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, fpr: { 3: [0x3f800000, 0xc0000000] } },
        [],
        [{ addr: MEM, len: 8 }]
    );
    add(
        "psq_st float unpaired writes one element",
        [A.psq_st(3, 4, 4, 1, 0), A.blr],
        { gpr: { 4: MEM }, fpr: { 3: [0xc2c80000, 0x3f800000] } },
        [],
        [{ addr: MEM + 4, len: 4 }]
    );
    add(
        "psq_st float flushes subnormals to signed zero",
        [A.psq_st(3, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, fpr: { 3: [0x00000001, 0x80000001] } },
        [],
        [{ addr: MEM, len: 8 }]
    );
    add(
        "psq_st float keeps infinities and negative zero",
        [A.psq_st(3, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, fpr: { 3: [0xff800000, 0x80000000] } },
        [],
        [{ addr: MEM, len: 8 }]
    );
    add(
        "psq_st u8 clamps and truncates",
        [A.psq_st(3, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: 4 }, fpr: { 3: [0x43964000, 0xbfc00000] } },
        [],
        [{ addr: MEM, len: 2 }]
    );
    add(
        "psq_st u8 truncates toward zero",
        [A.psq_st(3, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: 4 }, fpr: { 3: [0x42ffcccd, 0x3f000000] } },
        [],
        [{ addr: MEM, len: 2 }]
    );
    add(
        "psq_st u8 unpaired truncates",
        [A.psq_st(3, 4, 0, 1, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: 4 }, fpr: { 3: [0x40600000, 0x00000000] } },
        [],
        [{ addr: MEM, len: 1 }]
    );
    add(
        "psq_st s16 scales by a positive power of two",
        [A.psq_st(3, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: 7 | (1 << 8) }, fpr: { 3: [0x40200000, 0xc0200000] } },
        [],
        [{ addr: MEM, len: 4 }]
    );
    add(
        "psq_st s16 scales by a negative power of two",
        [A.psq_st(3, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: 7 | (62 << 8) }, fpr: { 3: [0x42c80000, 0xc2c80000] } },
        [],
        [{ addr: MEM, len: 4 }]
    );
    add(
        "psq_st u16 pair offsets ps1",
        [A.psq_st(3, 4, 2, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: 5 }, fpr: { 3: [0x3f800000, 0xbf800000] } },
        [],
        [{ addr: MEM + 2, len: 4 }]
    );
    add(
        "psq_st invalid type does not write",
        [A.psq_st(3, 4, 0, 0, 0), A.blr],
        { gpr: { 4: MEM }, gqr: { 0: 2 }, fpr: { 3: [0x3f800000, 0x40000000] } },
        [{ addr: MEM, hex: bytes(0x11, 0x22, 0x33, 0x44) }],
        [{ addr: MEM, len: 4 }]
    );
    add(
        "psq_stu updates rA and stores",
        [A.addi(5, 0, MEM + 4), A.psq_stu(2, 5, -4, 0, 0), A.blr],
        { fpr: { 2: [0x3f800000, 0x40000000] } },
        [],
        [{ addr: MEM, len: 8 }]
    );
    add(
        "psq_stu r0 base writes r0",
        [A.psq_stu(2, 0, -4, 0, 0), A.blr],
        { gpr: { 0: MEM + 4 }, fpr: { 2: [0x3f800000, 0x40000000] } },
        [],
        [{ addr: MEM, len: 8 }]
    );
    add(
        "psq_stx indexed store",
        [A.addi(4, 0, MEM), A.addi(5, 0, 8), A.psq_stx(2, 4, 5, 0, 0), A.blr],
        { fpr: { 2: [0x3f800000, 0x40000000] } },
        [],
        [{ addr: MEM + 8, len: 8 }]
    );
    add(
        "mtspr/mfspr round-trip the GQRs",
        [A.mtspr(912, 3), A.mfspr(4, 912), A.mtspr(919, 3), A.mfspr(5, 919), A.blr],
        { gpr: { 3: 0x10203040 } }
    );
    add("mtspr/mfspr round-trip HID2", [A.mtspr(920, 3), A.mfspr(4, 920), A.blr], { gpr: { 3: 0x11223344 } });

    return cases;
}

module.exports = { buildCases, A, BLR, MEM };
