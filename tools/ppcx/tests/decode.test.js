"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { decode } = require("../lib/decode.js");

test("decodes addi with r0 as the literal zero", () => {
    const d = decode(0x38600005); // addi r3, r0, 5
    assert.equal(d.name, "addi");
    assert.equal(d.rt, 3);
    assert.equal(d.ra, 0);
    assert.equal(d.imm, 5);
    assert.equal(d.supported, true);
});

test("decodes addic and addic.", () => {
    const a = decode(0x30630005); // addic r3, r3, 5
    assert.equal(a.name, "addic");
    assert.equal(a.rt, 3);
    assert.equal(a.ra, 3);
    assert.equal(a.imm, 5);
    const b = decode(0x34630005); // addic. r3, r3, 5
    assert.equal(b.name, "addic.");
    assert.equal(b.imm, 5);
});

test("decodes mfspr (mflr r0)", () => {
    const d = decode(0x7c0802a6);
    assert.equal(d.name, "mfspr");
    assert.equal(d.rt, 0);
    assert.equal(d.spr, 8);
});

test("decodes stwu with a negative offset and the update flag", () => {
    const d = decode(0x9421ffe0); // stwu r1, -32(r1)
    assert.equal(d.name, "stwu");
    assert.equal(d.kind, "store");
    assert.equal(d.update, true);
    assert.equal(d.ra, 1);
    assert.equal(d.rt, 1);
    assert.equal(d.imm, -32);
});

test("decodes blr and bctr", () => {
    assert.equal(decode(0x4e800020).branch, "blr");
    assert.equal(decode(0x4e800420).branch, "bctr");
});

test("bctrl carries the link bit", () => {
    const d = decode(0x4e800421); // bcctr 20, 0 with LK = 1
    assert.equal(d.name, "bcctr");
    assert.equal(d.branch, "bcctr");
    assert.equal(d.bo, 20);
    assert.equal(d.bi, 0);
    assert.equal(d.lk, true);
});

test("decodes the canonical nop", () => {
    const d = decode(0x60000000);
    assert.equal(d.name, "nop");
    assert.equal(d.supported, true);
});

test("decodes b and bl displacements", () => {
    const b = decode(0x48000008);
    assert.equal(b.branch, "b");
    assert.equal(b.li, 8);
    assert.equal(b.lk, false);
    const bl = decode(0x48000005);
    assert.equal(bl.branch, "bl");
    assert.equal(bl.li, 4);
    assert.equal(bl.lk, true);
    // Sign extension from bit 25 and displacements beyond 16 MB.
    const back = decode(0x4bfffff8);
    assert.equal(back.li, -8);
    const far = decode(0x4914fe04);
    assert.equal(far.li, 0x0114fe04);
});

test("decodes bc conditions", () => {
    const d = decode(0x4082000c); // bne +12
    assert.equal(d.name, "bc");
    assert.equal(d.bo, 4);
    assert.equal(d.bi, 2);
    assert.equal(d.bd, 12);
    const e = decode(0x4182000c); // beq +12
    assert.equal(e.bo, 12);
    assert.equal(e.bi, 2);
    // Negative displacement and AA/LK bits outside the field.
    const neg = decode(0x4082fed8); // bne -296
    assert.equal(neg.bd, -296);
    const aa = decode(0x4082feda); // same displacement, AA=1
    assert.equal(aa.aa, 1);
    assert.equal(aa.bd, -296);
});

test("decodes cmpi (cmpwi r3, 0)", () => {
    const d = decode(0x2c030000);
    assert.equal(d.name, "cmpi");
    assert.equal(d.crf, 0);
    assert.equal(d.ra, 3);
    assert.equal(d.imm, 0);
});

test("decodes loads and stores", () => {
    const lwz = decode(0x80640000); // lwz r3, 0(r4)
    assert.equal(lwz.name, "lwz");
    assert.equal(lwz.rt, 3);
    assert.equal(lwz.ra, 4);
    assert.equal(lwz.access, "u32");
    const stw = decode(0x90640004); // stw r3, 4(r4)
    assert.equal(stw.name, "stw");
    assert.equal(stw.kind, "store");
    assert.equal(stw.rt, 3);
    assert.equal(stw.ra, 4);
    assert.equal(stw.imm, 4);
});

test("decodes or (mr r3, r4)", () => {
    const d = decode(0x7c832378);
    assert.equal(d.name, "or");
    assert.equal(d.rt, 4);
    assert.equal(d.ra, 3);
    assert.equal(d.rb, 4);
});

test("decodes add", () => {
    const d = decode(0x7c632214); // add r3, r3, r4
    assert.equal(d.name, "add");
    assert.equal(d.rt, 3);
    assert.equal(d.ra, 3);
    assert.equal(d.rb, 4);
});

test("decodes add. with the record bit", () => {
    const d = decode(0x7c632215);
    assert.equal(d.name, "add");
    assert.equal(d.rc, true);
});

test("decodes rlwinm (slwi r3, r4, 5)", () => {
    const d = decode(0x5483283e);
    assert.equal(d.name, "rlwinm");
    assert.equal(d.rs, 4);
    assert.equal(d.ra, 3);
    assert.equal(d.sh, 5);
    assert.equal(d.mb, 0);
    assert.equal(d.me, 31);
    assert.equal(d.rc, false);
});

test("decodes fadds", () => {
    const d = decode(0xec22182a); // fadds f1, f2, f3
    assert.equal(d.name, "fadds");
    assert.equal(d.frd, 1);
    assert.equal(d.fra, 2);
    assert.equal(d.frb, 3);
});

test("decodes ps_add", () => {
    const d = decode(0x1022182a); // ps_add f1, f2, f3
    assert.equal(d.name, "ps_add");
    assert.equal(d.frd, 1);
    assert.equal(d.fra, 2);
    assert.equal(d.frb, 3);
});

test("decodes lfs and stfd", () => {
    const lfs = decode(0xc0230000); // lfs f1, 0(r3)
    assert.equal(lfs.name, "lfs");
    assert.equal(lfs.frd, 1);
    assert.equal(lfs.access, "f32");
    const stfd = decode(0xd8230008); // stfd f1, 8(r3)
    assert.equal(stfd.name, "stfd");
    assert.equal(stfd.frd, 1);
    assert.equal(stfd.access, "f64");
});

test("decodes fcmpu", () => {
    const w = (63 << 26) | (1 << 16) | (2 << 11); // fcmpu cr0, f1, f2
    const d = decode(w);
    assert.equal(d.name, "fcmpu");
    assert.equal(d.crf, 0);
    assert.equal(d.fra, 1);
    assert.equal(d.frb, 2);
});

test("decodes paired-single X-form (ps_mr)", () => {
    const w = (4 << 26) | (3 << 21) | (4 << 11) | (72 << 1); // ps_mr f3, f4
    const d = decode(w);
    assert.equal(d.name, "ps_mr");
    assert.equal(d.frd, 3);
    assert.equal(d.frb, 4);
});

test("decodes paired-single A-form with the C operand (ps_madds0)", () => {
    const w = (4 << 26) | (1 << 21) | (2 << 16) | (3 << 11) | (4 << 6) | (14 << 1);
    const d = decode(w);
    assert.equal(d.name, "ps_madds0");
    assert.equal(d.frd, 1);
    assert.equal(d.fra, 2);
    assert.equal(d.frb, 3);
    assert.equal(d.frc, 4);
});

test("marks unsupported instructions without losing the name", () => {
    const sc = decode(0x44000002);
    assert.equal(sc.supported, false);
    const psq = decode((56 << 26) | (1 << 21)); // psq_l f1, 0(r0), 0, 0
    assert.equal(psq.name, "psq_l");
    assert.equal(psq.supported, true);
});

test("decodes psq fields and the indexed forms", () => {
    const d = decode((57 << 26) | (3 << 21) | (4 << 16) | (1 << 15) | (5 << 12) | ((-8) & 0xfff));
    assert.equal(d.name, "psq_lu");
    assert.equal(d.form, "PSQ");
    assert.equal(d.kind, "load");
    assert.equal(d.access, "psq");
    assert.equal(d.frd, 3);
    assert.equal(d.ra, 4);
    assert.equal(d.w, 1);
    assert.equal(d.i, 5);
    assert.equal(d.disp, -8);
    assert.equal(d.update, true);

    const st = decode((60 << 26) | (2 << 21) | 0x123);
    assert.equal(st.name, "psq_st");
    assert.equal(st.kind, "store");
    assert.equal(st.update, false);
    assert.equal(st.disp, 0x123);

    const lx = decode((4 << 26) | (7 << 21) | (8 << 16) | (9 << 11) | (1 << 10) | (2 << 7) | (38 << 1));
    assert.equal(lx.name, "psq_lux");
    assert.equal(lx.frd, 7);
    assert.equal(lx.ra, 8);
    assert.equal(lx.rb, 9);
    assert.equal(lx.w, 1);
    assert.equal(lx.i, 2);
    assert.equal(lx.update, true);

    const stx = decode((4 << 26) | (39 << 1));
    assert.equal(stx.name, "psq_stux");
    assert.equal(stx.kind, "store");
    assert.equal(stx.update, true);

    // The sub-opcode pivot never shadows the paired-single tables.
    for (const sub6 of [6, 7, 38, 39]) {
        for (let ix = 0; ix < 8; ix++) {
            for (let wx = 0; wx < 2; wx++) {
                const q = decode((4 << 26) | (wx << 10) | (ix << 7) | (sub6 << 1));
                assert.ok(q.name.startsWith("psq_"), `${q.name} for sub6=${sub6} ix=${ix} wx=${wx}`);
            }
        }
    }
    assert.equal(decode((4 << 26) | (72 << 1)).name, "ps_mr");
    assert.equal(decode((4 << 26) | (21 << 1)).name, "ps_add");
});

test("decodes mtcrf fields", () => {
    const w = (31 << 26) | (3 << 21) | (0x80 << 12) | (144 << 1); // mtcrf 0x80, r3
    const d = decode(w);
    assert.equal(d.name, "mtcrf");
    assert.equal(d.rs, 3);
    assert.equal(d.fm, 0x80);
});

test("decodes sync and lwsync", () => {
    const sync = (31 << 26) | (598 << 1);
    const lwsync = sync | (1 << 21);
    assert.equal(sync, 0x7c0004ac);
    assert.equal(decode(sync).name, "sync");
    assert.equal(decode(lwsync).name, "lwsync");
});

test("decodes mcrf", () => {
    const w = (19 << 26) | (1 << 23) | (2 << 16) | (0 << 1); // mcrf cr1, cr2
    const d = decode(w);
    assert.equal(d.name, "mcrf");
    assert.equal(d.crfd, 1);
    assert.equal(d.crfs, 2);
    assert.equal(d.supported, true);
});

test("decodes lmw and stmw with the register range", () => {
    const lmw = decode(0xb8610000); // lmw r3, 0(r1)
    assert.equal(lmw.name, "lmw");
    assert.equal(lmw.kind, "load-multi");
    assert.equal(lmw.rt, 3);
    assert.equal(lmw.ra, 1);
    assert.equal(lmw.imm, 0);
    assert.equal(lmw.supported, true);
    const stmw = decode(0xbc610000); // stmw r3, 0(r1)
    assert.equal(stmw.name, "stmw");
    assert.equal(stmw.kind, "store-multi");
    assert.equal(stmw.rt, 3);
    assert.equal(stmw.supported, true);
    const neg = decode(0xb861fffc); // lmw r3, -4(r1)
    assert.equal(neg.imm, -4);
});

test("decodes tw with its trap condition field", () => {
    const d = decode(0x7fe00008); // tw 31, r0, r0
    assert.equal(d.name, "tw");
    assert.equal(d.form, "X");
    assert.equal(d.to, 31);
    assert.equal(d.ra, 0);
    assert.equal(d.rb, 0);
    assert.equal(d.supported, true);
});

test("decodes indexed floating-point accesses", () => {
    const lfsx = decode((31 << 26) | (13 << 21) | (12 << 16) | (0 << 11) | (535 << 1));
    assert.equal(lfsx.name, "lfsx");
    assert.equal(lfsx.kind, "load");
    assert.equal(lfsx.access, "f32");
    assert.equal(lfsx.frd, 13);
    assert.equal(lfsx.ra, 12);
    assert.equal(lfsx.rb, 0);
    const stfdux = decode((31 << 26) | (5 << 21) | (3 << 16) | (4 << 11) | (759 << 1));
    assert.equal(stfdux.name, "stfdux");
    assert.equal(stfdux.kind, "store");
    assert.equal(stfdux.access, "f64");
    assert.equal(stfdux.update, true);
    assert.equal(stfdux.frd, 5);
});

test("decodes lswi/stswi with the byte count", () => {
    const lswi = decode((31 << 26) | (3 << 21) | (4 << 16) | (8 << 11) | (597 << 1));
    assert.equal(lswi.name, "lswi");
    assert.equal(lswi.rt, 3);
    assert.equal(lswi.ra, 4);
    assert.equal(lswi.nb, 8);
    assert.equal(lswi.supported, true);
    const stswi = decode((31 << 26) | (3 << 21) | (0 << 16) | (0 << 11) | (725 << 1));
    assert.equal(stswi.name, "stswi");
    assert.equal(stswi.nb, 0);
    assert.equal(stswi.supported, true);
});

test("fres lives in opcode 59 and the estimate ops are supported", () => {
    const fres = decode((59 << 26) | (1 << 21) | (2 << 11) | (24 << 1));
    assert.equal(fres.name, "fres");
    assert.equal(fres.frd, 1);
    assert.equal(fres.frb, 2);
    assert.equal(fres.supported, true);
    const frsqrte = decode((63 << 26) | (1 << 21) | (2 << 11) | (26 << 1));
    assert.equal(frsqrte.name, "frsqrte");
    assert.equal(frsqrte.supported, true);
    const ps = decode((4 << 26) | (1 << 21) | (2 << 11) | (24 << 1));
    assert.equal(ps.name, "ps_res");
    assert.equal(ps.supported, true);
});

test("decodes the signed mulli immediate", () => {
    const d = decode(0x1c64ffff); // mulli r3, r4, 0xffff
    assert.equal(d.name, "mulli");
    assert.equal(d.imm, -1);
    assert.equal(d.uimm, 0xffff);
});

test("cmpli and cmpi keep both immediate views", () => {
    const l = decode(0x2803ffff); // cmpli cr0, r3, 0xffff
    assert.equal(l.name, "cmpli");
    assert.equal(l.uimm, 0xffff);
    assert.equal(l.imm, -1);
    const i = decode(0x2c03ffff); // cmpi cr0, r3, -1
    assert.equal(i.name, "cmpi");
    assert.equal(i.imm, -1);
});

test("bc carries the link bit", () => {
    const d = decode(0x40820021); // bcl 4, 2, +32
    assert.equal(d.branch, "bc");
    assert.equal(d.name, "bcl");
    assert.equal(d.lk, true);
    assert.equal(d.bd, 32);
});

test("the OE field is only reported for real XO-form instructions", () => {
    // Bit 10 belongs to the extended opcode of X-form instructions: srw (536)
    // and extsb (954) both have it set and must not report an OE field.
    const srw = decode((31 << 26) | (1 << 21) | (2 << 16) | (3 << 11) | (536 << 1));
    assert.equal(srw.name, "srw");
    assert.equal(srw.oe, undefined);
    assert.equal(srw.form, "X");
    const extsb = decode((31 << 26) | (4 << 21) | (3 << 16) | (954 << 1));
    assert.equal(extsb.name, "extsb");
    assert.equal(extsb.oe, undefined);
    const add = decode((31 << 26) | (3 << 21) | (3 << 16) | (4 << 11) | (266 << 1));
    assert.equal(add.oe, false);
    assert.equal(add.form, "XO");
});

test("XO-form instructions with OE = 1 decode instead of trapping", () => {
    // addo r3, r3, r4: bit 10 is OE, so the 10-bit field reads 778, not 266.
    const d = decode(0x7c632614);
    assert.equal(d.name, "add");
    assert.equal(d.oe, true);
    assert.equal(d.rt, 3);
    assert.equal(d.ra, 3);
    assert.equal(d.rb, 4);
    const mullwo = decode((31 << 26) | (3 << 21) | (3 << 16) | (4 << 11) | (235 << 1) | (1 << 10));
    assert.equal(mullwo.name, "mullw");
    assert.equal(mullwo.oe, true);
    // mulhw has no OE field: an OE=1 encoding stays undecoded rather than
    // silently becoming a different instruction.
    const bad = decode((31 << 26) | (3 << 21) | (3 << 16) | (4 << 11) | (75 << 1) | (1 << 10));
    assert.equal(bad.supported, false);
    assert.equal(bad.name, "op31-xo587");
});
