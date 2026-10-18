"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { translateFunction } = require("../lib/translate.js");

function textSection(words, base = 0x1000) {
    const data = Buffer.alloc(words.length * 4);
    words.forEach((w, i) => data.writeUInt32BE(w >>> 0, i * 4));
    return { data, base };
}

function translate(words, opts = {}) {
    const base = opts.base || 0x1000;
    const { data } = textSection(words, base);
    const start = base;
    const end = base + words.length * 4;
    return translateFunction({
        data,
        base,
        start,
        end,
        textBase: opts.textBase !== undefined ? opts.textBase : base,
        textEnd: opts.textEnd !== undefined ? opts.textEnd : end,
        startSet: opts.startSet || [start],
        emitSet: opts.emitSet || [start],
        callSite: opts.callSite || new Map(),
        dataSite: opts.dataSite || new Map(),
    });
}

test("translates addi and blr into a C function", () => {
    const r = translate([0x38600005, 0x4e800020]);
    assert.match(r.code, /static void f_00001000\(Cpu \*c\) \{/);
    assert.match(r.code, /c->gpr\[3\] = 0x5u;/);
    assert.match(r.code, /return;/);
    assert.doesNotMatch(r.code, /PPCX_UNIMPL/);
    assert.equal(r.unsupported.length, 0);
});

test("stwu stores the old value and then updates r1", () => {
    const r = translate([0x9421ffe0, 0x7c0802a6, 0x90010024, 0x38210020, 0x4e800020]);
    assert.match(r.code, /u32 ea;/);
    const store = r.code.indexOf("ppcx_wr32(ea, c->gpr[1]);");
    const update = r.code.indexOf("c->gpr[1] = ea;");
    assert.ok(store >= 0, "stores through the computed ea");
    assert.ok(update > store, "the rA update happens after the store");
    assert.match(r.code, /c->gpr\[0\] = ppcx_mfspr\(c, 8u\);/);
});

test("update-form loads win over the rA update when rT = rA", () => {
    const w = (33 << 26) | (4 << 21) | (4 << 16) | 4; // lwzu r4, 4(r4)
    const r = translate([w, 0x4e800020]);
    const update = r.code.indexOf("c->gpr[4] = ea;");
    const load = r.code.indexOf("c->gpr[4] = ppcx_rd32(ea);");
    assert.ok(update >= 0 && load > update, "the load executes after the rA update");
});

test("substitutes an imported call at its REL24 site", () => {
    const callSite = new Map([[0x2000, 7]]);
    const r = translate([0x48000005, 0x4e800020], { base: 0x2000, callSite });
    assert.match(r.code, /c->lr = 0x00002004u;/);
    assert.match(r.code, /PPCX_HLE\(c, 7\);/);
    assert.deepEqual(r.hleCalls, [7]);
});

test("a `b` to an import becomes a tail HLE call without touching LR", () => {
    // v208 FUN_031FA4CC: r3 = &UNK_031FA4C8; b ProcUIInit (REL24 site).
    const callSite = new Map([[0x4000, 359]]);
    const r = translate([0x4914fe04, 0x4e800020], { base: 0x4000, callSite });
    assert.match(r.code, /PPCX_HLE\(c, 359\);/);
    assert.doesNotMatch(r.code, /c->lr =/);
    assert.deepEqual(r.hleCalls, [359]);
});

test("displacements beyond 16 MB reach the right target", () => {
    const r = translate([0x4914fe04, 0x4e800020], {
        base: 0x02000020,
        textBase: 0x02000020,
        textEnd: 0x05000000,
    });
    assert.match(r.code, /PPCX_DISPATCH\(c, 0x0314fe24u\);/);
});

test("substitutes address-taken imports (HA/LO pair)", () => {
    const dataSite = new Map([
        [0x2002, { index: 3, type: 6 }],
        [0x2006, { index: 3, type: 4 }],
    ]);
    const r = translate([0x3c600000, 0x38630000, 0x4e800020], { base: 0x2000, dataSite });
    assert.match(r.code, /c->gpr\[3\] = \(PPCX_IMPORT_ADDR\(3\) \+ 0x8000u\) & 0xffff0000u;/);
    assert.match(r.code, /c->gpr\[3\] = c->gpr\[3\] \+ \(u32\)\(s32\)\(PPCX_IMPORT_ADDR\(3\) & 0xffffu\);/);
});

test("conditional branches to local targets become goto + label", () => {
    const r = translate([0x2c030000, 0x40820008, 0x60000000, 0x4e800020]);
    assert.match(r.code, /if \(ppcx_bc\(c, 0x4u, 0x2u\)\) goto L_0000100C;/);
    assert.match(r.code, /L_0000100C:;/);
});

test("local branch targets are not callees", () => {
    const r = translate([0x2c030000, 0x40820008, 0x60000000, 0x4e800020]);
    assert.equal(r.callees.length, 0);
});

test("direct call and tail call to translated functions", () => {
    const startSet = [0x2000, 0x3000];
    const emitSet = [0x2000, 0x3000];
    const call = translate([0x48001001, 0x4e800020], { base: 0x2000, startSet, emitSet, textEnd: 0x4000 });
    assert.match(call.code, /c->lr = 0x00002004u;/);
    assert.match(call.code, /f_00003000\(c\);/);
    const tail = translate([0x48001000, 0x4e800020], { base: 0x2000, startSet, emitSet, textEnd: 0x4000 });
    assert.match(tail.code, /PPCX_TAILCALL\(c, f_00003000\);/);
    assert.equal(tail.callees.length, 1);
    assert.equal(tail.callees[0].addr, 0x3000);
});

test("untranslated call targets dispatch at runtime", () => {
    const startSet = [0x2000, 0x3000];
    const r = translate([0x48001001, 0x4e800020], { base: 0x2000, startSet, textEnd: 0x4000 });
    assert.match(r.code, /PPCX_DISPATCH\(c, 0x00003000u\);/);
    assert.deepEqual(r.externalTargets, [0x3000]);
});

test("indirect tails through CTR dispatch and return", () => {
    const r = translate([0x4e800420, 0x4e800020]); // bctr
    assert.match(r.code, /\{\n\s+PPCX_DISPATCH\(c, c->ctr & ~3u\);\n\s+return;\n\s+\}/);
});

test("bctrl calls through CTR and keeps running", () => {
    const r = translate([0x4e800421, 0x4e800020]); // bctrl
    assert.match(r.code, /u32 t = c->ctr & ~3u;/);
    assert.match(r.code, /c->lr = 0x00001004u;/);
    assert.match(r.code, /PPCX_DISPATCH\(c, t\);/);
});

test("conditional bclr returns only when the condition holds", () => {
    const w = (19 << 26) | (4 << 21) | (2 << 16) | (16 << 1); // bclr 4, 2
    const r = translate([w, 0x4e800020]);
    assert.match(r.code, /if \(ppcx_bc\(c, 0x4u, 0x2u\)\) return;/);
});

test("unsupported instructions become named traps", () => {
    const r = translate([0x44000002, 0x4e800020]);
    assert.match(r.code, /PPCX_UNIMPL\(c, 0x00001000u\); \/\* op17 is not supported yet \*\//);
    assert.equal(r.unsupported[0].name, "op17");
    assert.equal(r.unsupported[0].count, 1);
});

test("the record bit updates CR0 after the operation", () => {
    const r = translate([0x7c632215, 0x4e800020]); // add. r3, r3, r4
    assert.match(r.code, /c->gpr\[3\] = c->gpr\[3\] \+ c->gpr\[4\];/);
    assert.match(r.code, /ppcx_cr0\(c, c->gpr\[3\]\);/);
});

test("single-precision operations fill both lanes", () => {
    const r = translate([0xec22182a, 0x4e800020]); // fadds f1, f2, f3
    assert.match(
        r.code,
        /PPCX_FILL_SINGLE\(c->fpr\[1\], \(float\)\(c->fpr\[2\]\.ps0\.d \+ c->fpr\[3\]\.ps0\.d\)\);/
    );
});

test("ps_madds0 multiplies both lanes by C lane 0", () => {
    const w = (4 << 26) | (1 << 21) | (2 << 16) | (3 << 11) | (4 << 6) | (14 << 1);
    const r = translate([w, 0x4e800020]);
    assert.match(r.code, /ppcx_fma_s\(c->fpr\[2\]\.ps0\.d, c->fpr\[4\]\.ps0\.d, c->fpr\[3\]\.ps0\.d\)/);
    assert.match(r.code, /ppcx_fma_s\(c->fpr\[2\]\.ps1\.d, c->fpr\[4\]\.ps0\.d, c->fpr\[3\]\.ps1\.d\)/);
});

test("ps_sum0 adds A lane 0 to B lane 1", () => {
    const w = (4 << 26) | (1 << 21) | (2 << 16) | (3 << 11) | (4 << 6) | (10 << 1);
    const r = translate([w, 0x4e800020]);
    assert.match(r.code, /\(float\)\(c->fpr\[2\]\.ps0\.d \+ c->fpr\[3\]\.ps1\.d\)/);
    assert.match(r.code, /\(float\)c->fpr\[4\]\.ps1\.d/);
});

test("blr on an unconditional bclr returns", () => {
    const r = translate([0x4e800020]);
    assert.match(r.code, /return;/);
    assert.doesNotMatch(r.code, /PPCX_DISPATCH\(c, 0x00001004u\)/);
});

test("falling off the end of the range dispatches to the next address", () => {
    const r = translate([0x38600005]);
    assert.match(r.code, /PPCX_DISPATCH\(c, 0x00001004u\); \/\* fallen through the end of the range \*\//);
});

test("lmw/stmw walk the register range from the evaluated address", () => {
    const lmw = translate([0xb861ffe0, 0x4e800020]); // lmw r3, -32(r1)
    assert.match(lmw.code, /ppcx_lmw\(c, \(u32\)\(c->gpr\[1\] \+ 0xffffffe0u\), 3u\);/);
    assert.equal(lmw.unsupported.length, 0);
    const stmw = translate([0xbc010000, 0x4e800020]); // stmw r0, 0(r1)
    assert.match(stmw.code, /ppcx_stmw\(c, \(u32\)\(c->gpr\[1\] \+ 0x0u\), 0u\);/);
    assert.equal(stmw.unsupported.length, 0);
    // rA = 0 means the literal zero, not r0.
    const zero = translate([0xb8000000, 0x4e800020]); // lmw r0, 0(r0)
    assert.match(zero.code, /ppcx_lmw\(c, 0x0u, 0u\);/);
});

test("tw becomes a condition-checked guest trap", () => {
    const w = (31 << 26) | (31 << 21) | (3 << 16) | (4 << 11) | (4 << 1); // tw 31, r3, r4
    const r = translate([w, 0x4e800020]);
    assert.match(r.code, /ppcx_tw\(c, 0x1fu, c->gpr\[3\], c->gpr\[4\], 0x00001000u\);/);
    assert.equal(r.unsupported.length, 0);
});

test("indexed floating-point accesses reuse the load/store paths", () => {
    const l = translate([(31 << 26) | (13 << 21) | (12 << 16) | (0 << 11) | (535 << 1), 0x4e800020]);
    assert.match(
        l.code,
        /PPCX_FILL_SINGLE\(c->fpr\[13\], ppcx_bits_f32\(ppcx_rd32\(\(u32\)\(c->gpr\[12\] \+ c->gpr\[0\]\)\)\)\);/
    );
    assert.equal(l.unsupported.length, 0);
    const su = translate([(31 << 26) | (7 << 21) | (3 << 16) | (4 << 11) | (759 << 1), 0x4e800020]);
    assert.match(su.code, /u32 ea;/);
    const store = su.code.indexOf("ppcx_wr64(ea, c->fpr[7].ps0.u);");
    const update = su.code.indexOf("c->gpr[3] = ea;");
    assert.ok(store >= 0 && update > store, "the rA update happens after the store");
});

test("lswi/stswi call the string helpers", () => {
    const l = translate([(31 << 26) | (3 << 21) | (4 << 16) | (8 << 11) | (597 << 1), 0x4e800020]);
    assert.match(l.code, /ppcx_lswi\(c, c->gpr\[4\], 3u, 8u\);/);
    const s = translate([(31 << 26) | (3 << 21) | (0 << 16) | (8 << 11) | (725 << 1), 0x4e800020]);
    assert.match(s.code, /ppcx_stswi\(c, 0u, 3u, 8u\);/);
});

test("reciprocal estimates lower to the exact-value helpers", () => {
    const fres = translate([(59 << 26) | (1 << 21) | (2 << 11) | (24 << 1), 0x4e800020]);
    assert.match(fres.code, /c->fpr\[1\]\.ps0\.d = ppcx_res_d\(c->fpr\[2\]\.ps0\.d\);/);
    assert.equal(fres.unsupported.length, 0);
    const frsqrte = translate([(63 << 26) | (3 << 21) | (4 << 11) | (26 << 1), 0x4e800020]);
    assert.match(frsqrte.code, /c->fpr\[3\]\.ps0\.d = ppcx_rsqrte_d\(c->fpr\[4\]\.ps0\.d\);/);
    const ps = translate([(4 << 26) | (5 << 21) | (6 << 11) | (24 << 1), 0x4e800020]);
    assert.match(
        ps.code,
        /PPCX_SET_PS2\(c->fpr\[5\], \(float\)ppcx_res_d\(c->fpr\[6\]\.ps0\.d\), \(float\)ppcx_res_d\(c->fpr\[6\]\.ps1\.d\)\);/
    );
});
