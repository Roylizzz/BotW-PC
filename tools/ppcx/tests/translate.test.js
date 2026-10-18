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
