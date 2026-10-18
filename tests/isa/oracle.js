"use strict";

/**
 * Independent PowerPC-integer reference model ("oracle") for BotW-PC.
 *
 * This file is a second, independent implementation of the instruction
 * semantics that tools/ppcx emits C for. It shares no code with
 * tools/ppcx/lib/decode.js or src/runtime/include/ppcx_abi.h: it decodes
 * words and computes results directly from the ISA definitions, using the
 * behaviour of the two reference implementations of this CPU family
 * (the reference PowerPC emulator used during development and a second,
 * independent one) for the parts the ISA leaves undefined (divide by zero,
 * OV/SO updates, lswi/stswi partial groups).
 *
 * The point of a second implementation is to be able to disagree. tests/isa
 * runs the same guest programs through the generated C (compiled and
 * executed) and through this model, and fails when the resulting CPU and
 * memory state differs.
 *
 * Scope: the integer core, branches are NOT modelled (test programs have a
 * single control-flow path ending in blr), and floating point is out of
 * scope here (covered by the float fidelity notes in the runtime header).
 */

const ARENA = 0x00040000; // 256 KiB: the harness allocates the same amount

/* ------------------------------------------------------------------ */
/* Small bit helpers                                                   */
/* ------------------------------------------------------------------ */

const u32 = (x) => x >>> 0;
const s32 = (x) => (x | 0);

function rotl32(v, n) {
    n &= 31;
    return n ? u32((v << n) | (v >>> (32 - n))) : u32(v);
}

/**
 * Rotation mask, defined bit by bit from the ISA description: a mask of ones
 * from bit MB through bit ME, where bit 0 is the most significant bit of the
 * 32-bit word and the range wraps through bit 31 back to bit 0.
 */
function maskBits(mb, me) {
    let m = 0;
    const span = (me - mb) & 31;
    for (let i = 0; i <= span; i++) {
        m = u32(m | (0x80000000 >>> ((mb + i) & 31)));
    }
    return m;
}

/* ------------------------------------------------------------------ */
/* Machine state                                                       */
/* ------------------------------------------------------------------ */

function newState() {
    return {
        gpr: new Uint32Array(32),
        cr: 0,
        lr: 0,
        ctr: 0,
        xer: 0,
        resv: 0xffffffff,
        mem: new Uint8Array(ARENA),
    };
}

const XER_SO = 0x80000000;const XER_OV = 0x40000000;
const XER_CA = 0x20000000;

const rd8 = (s, ea) => s.mem[ea];
const rd16 = (s, ea) => (s.mem[ea] << 8) | s.mem[ea + 1];
const rd32 = (s, ea) => u32((s.mem[ea] << 24) | (s.mem[ea + 1] << 16) | (s.mem[ea + 2] << 8) | s.mem[ea + 3]);
function wr8(s, ea, v) {
    s.mem[ea] = v & 0xff;
}
function wr16(s, ea, v) {
    s.mem[ea] = (v >>> 8) & 0xff;
    s.mem[ea + 1] = v & 0xff;
}
function wr32(s, ea, v) {
    s.mem[ea] = (v >>> 24) & 0xff;
    s.mem[ea + 1] = (v >>> 16) & 0xff;
    s.mem[ea + 2] = (v >>> 8) & 0xff;
    s.mem[ea + 3] = v & 0xff;
}

/* ------------------------------------------------------------------ */
/* Condition register                                                  */
/* ------------------------------------------------------------------ */

function setCRField(s, crf, v) {
    const sh = 28 - 4 * crf;
    s.cr = u32((s.cr & ~(0xf << sh)) | ((v & 0xf) << sh));
}

const crSO = (s) => ((s.xer & XER_SO) ? 1 : 0);

function setCRFromCompare(s, crf, lt, gt, eq) {
    setCRField(s, crf, (lt ? 8 : 0) | (gt ? 4 : 0) | (eq ? 2 : 0) | crSO(s));
}

function setCR0(s, v) {
    const x = s32(v);
    setCRFromCompare(s, 0, x < 0, x > 0, x === 0);
}

function setCarry(s, ca) {
    s.xer = u32((s.xer & ~XER_CA) | (ca ? XER_CA : 0));
}

function setOV(s, ov) {
    if (ov) s.xer = u32(s.xer | XER_OV | XER_SO);
    else s.xer = u32(s.xer & ~XER_OV);
}

/* Overflow of a signed add: both inputs share a sign and the result differs. */
const addOverflowed = (x, y, r) => (((x ^ r) & (y ^ r)) >>> 31) !== 0;

/* ------------------------------------------------------------------ */
/* Instruction execution                                               */
/* ------------------------------------------------------------------ */

const RT = (w) => (w >>> 21) & 0x1f;
const RA = (w) => (w >>> 16) & 0x1f;
const RB = (w) => (w >>> 11) & 0x1f;
const SH = (w) => (w >>> 11) & 0x1f;
const MB = (w) => (w >>> 6) & 0x1f;
const ME = (w) => (w >>> 1) & 0x1f;
const CRF = (w) => (w >>> 23) & 0x7;
const XO = (w) => (w >>> 1) & 0x3ff;
const RC = (w) => (w & 1) !== 0;
const OE = (w) => ((w >>> 10) & 1) !== 0;
const SIMM = (w) => (w << 16) >> 16;
const UIMM = (w) => w & 0xffff;
const SPR = (w) => (((w >>> 11) & 0x1f) << 5) | ((w >>> 16) & 0x1f);

/**
 * Executes one instruction. Returns nothing; unsupported words are reported
 * through `onUnsupported` so that a gap in the oracle can never look like a
 * pass.
 */
function step(s, w, onUnsupported) {
    const op = w >>> 26;

    switch (op) {
        /* --- D-form arithmetic and logical immediates --- */
        case 7: {
            // mulli: signed immediate
            const t = s32(s.gpr[RA(w)]) * SIMM(w);
            s.gpr[RT(w)] = u32(Math.trunc(t) >>> 0);
            return;
        }
        case 8: {
            // subfic: rD = imm - (RA); note RA = 0 reads r0 here
            const t = BigInt(UIMM(w)) + BigInt(u32(~s.gpr[RA(w)])) + 1n;
            s.gpr[RT(w)] = u32(Number(t & 0xffffffffn));
            setCarry(s, t > 0xffffffffn);
            return;
        }
        case 10:
        case 11: {
            const a = s.gpr[RA(w)];
            if (op === 10) setCRFromCompare(s, CRF(w), a < UIMM(w), a > UIMM(w), a === UIMM(w));
            else {
                const b = SIMM(w);
                setCRFromCompare(s, CRF(w), s32(a) < b, s32(a) > b, s32(a) === b);
            }
            return;
        }
        case 12:
        case 13: {
            const a = s.gpr[RA(w)];
            const t = BigInt(a) + BigInt(SIMM(w) >>> 0);
            s.gpr[RT(w)] = u32(Number(t & 0xffffffffn));
            setCarry(s, t > 0xffffffffn);
            if (op === 13) setCR0(s, s.gpr[RT(w)]);
            return;
        }
        case 14:
        case 15: {
            // addi/addis: RA = 0 means the literal zero (unlike the family above)
            const imm = op === 14 ? SIMM(w) : (SIMM(w) << 16);
            const a = RA(w) === 0 ? 0 : s.gpr[RA(w)];
            s.gpr[RT(w)] = u32(a + imm);
            return;
        }
        case 24: s.gpr[RA(w)] = u32(s.gpr[RT(w)] | UIMM(w)); return;
        case 25: s.gpr[RA(w)] = u32(s.gpr[RT(w)] | (UIMM(w) << 16)); return;
        case 26: s.gpr[RA(w)] = u32(s.gpr[RT(w)] ^ UIMM(w)); return;
        case 27: s.gpr[RA(w)] = u32(s.gpr[RT(w)] ^ (UIMM(w) << 16)); return;
        case 28: s.gpr[RA(w)] = u32(s.gpr[RT(w)] & UIMM(w)); setCR0(s, s.gpr[RA(w)]); return;
        case 29: s.gpr[RA(w)] = u32(s.gpr[RT(w)] & (UIMM(w) << 16)); setCR0(s, s.gpr[RA(w)]); return;

        /* --- loads and stores --- */
        case 32: s.gpr[RT(w)] = rd32(s, dEA(s, w)); return;
        case 33: updLoad(s, w, rd32(s, dEA(s, w))); return;
        case 34: s.gpr[RT(w)] = rd8(s, dEA(s, w)); return;
        case 35: updLoad(s, w, rd8(s, dEA(s, w))); return;
        case 36: wr32(s, dEA(s, w), s.gpr[RT(w)]); return;
        case 37: updStore(s, w, s.gpr[RT(w)]); return;
        case 38: wr8(s, dEA(s, w), s.gpr[RT(w)]); return;
        case 39: {
            const ea = dEA(s, w);
            wr8(s, ea, s.gpr[RT(w)]);
            s.gpr[RA(w)] = ea;
            return;
        }
        case 40: s.gpr[RT(w)] = rd16(s, dEA(s, w)); return;
        case 41: updLoad(s, w, rd16(s, dEA(s, w))); return;
        case 42: s.gpr[RT(w)] = u32(s32((rd16(s, dEA(s, w)) << 16) >> 16)); return;
        case 43: updLoad(s, w, u32(s32((rd16(s, dEA(s, w)) << 16) >> 16))); return;
        case 44: wr16(s, dEA(s, w), s.gpr[RT(w)]); return;
        case 45: updStore(s, w, s.gpr[RT(w)] & 0xffff); return;
        case 46: {
            // lmw: the base register is written by the range but the EA is fixed
            const ea = dEA(s, w);
            for (let n = RT(w); n < 32; n++) s.gpr[n] = rd32(s, ea + (n - RT(w)) * 4);
            return;
        }
        case 47: {
            const ea = dEA(s, w);
            for (let n = RT(w); n < 32; n++) wr32(s, ea + (n - RT(w)) * 4, s.gpr[n]);
            return;
        }
        case 48: case 49: case 52: case 53:
            unsupported(onUnsupported, "float load/store", w);
            return;

        /* --- rotate and mask --- */
        case 20: {
            const mask = maskBits(MB(w), ME(w));
            s.gpr[RA(w)] = u32((s.gpr[RA(w)] & ~mask) | (rotl32(s.gpr[RT(w)], SH(w)) & mask));
            if (RC(w)) setCR0(s, s.gpr[RA(w)]);
            return;
        }
        case 21: {
            s.gpr[RA(w)] = u32(rotl32(s.gpr[RT(w)], SH(w)) & maskBits(MB(w), ME(w)));
            if (RC(w)) setCR0(s, s.gpr[RA(w)]);
            return;
        }
        case 23: {
            s.gpr[RA(w)] = u32(rotl32(s.gpr[RT(w)], s.gpr[RB(w)] & 31) & maskBits(MB(w), ME(w)));
            if (RC(w)) setCR0(s, s.gpr[RA(w)]);
            return;
        }

        /* --- branches (not modelled: test programs have no branches) --- */
        case 16: case 18:
            unsupported(onUnsupported, "branch", w);
            return;

        case 19: return step19(s, w, onUnsupported);
        case 31: return step31(s, w, onUnsupported);
        case 56: case 57: case 60: case 61:
            unsupported(onUnsupported, "psq", w);
            return;
        default:
            unsupported(onUnsupported, "op" + op, w);
    }
}

function unsupported(onUnsupported, what, w) {
    if (onUnsupported) onUnsupported(what, w);
    else throw new Error(`oracle: unsupported instruction (${what}) 0x${u32(w).toString(16)}`);
}

function dEA(s, w) {
    return u32((RA(w) === 0 ? 0 : s.gpr[RA(w)]) + SIMM(w));
}

function xEA(s, w) {
    return u32((RA(w) === 0 ? 0 : s.gpr[RA(w)]) + s.gpr[RB(w)]);
}

function updLoad(s, w, v) {
    const ea = dEA(s, w);
    s.gpr[RA(w)] = ea;
    s.gpr[RT(w)] = u32(v);
}

function updStore(s, w, v) {
    const ea = dEA(s, w);
    if (w >>> 26 === 37) wr32(s, ea, u32(v));
    else wr16(s, ea, v);
    s.gpr[RA(w)] = ea;
}

function step19(s, w) {
    const xo = XO(w);
    if (xo === 16 || xo === 528) {
        // bclr/bcctr: not modelled (no branches in the test programs)
        throw new Error("oracle: branch instructions are not modelled");
    }
    if (xo === 150) return; // isync
    if (xo === 0) {
        // mcrf
        const crfd = CRF(w);
        const crfs = (w >>> 16) & 0x7;
        setCRField(s, crfd, (s.cr >>> (28 - 4 * crfs)) & 0xf);
        return;
    }
    // cr logical ops
    const bit = (n) => u32(s.cr >>> (31 - n)) & 1;
    const A = bit((w >>> 16) & 0x1f);
    const B = bit((w >>> 11) & 0x1f);
    let v;
    switch (xo) {
        case 33: v = A & (B ^ 1); break;
        case 129: v = A & (B ^ 1); break;
        case 193: v = A ^ B; break;
        case 225: v = (A & B) ^ 1; break;
        case 257: v = A & B; break;
        case 289: v = (A ^ B) ^ 1; break;
        case 417: v = A | (B ^ 1); break;
        case 449: v = A | B; break;
        default:
            throw new Error(`oracle: unknown opcode-19 XO ${xo}`);
    }
    const target = (w >>> 21) & 0x1f;
    const m = 1 << (31 - target);
    s.cr = u32((s.cr & ~m) | ((v & 1) << (31 - target)));
}

/* Extended opcodes that are XO-form (they carry a real OE bit at 10). */
const XO_FORM = new Set([266, 10, 138, 234, 202, 40, 8, 136, 232, 200, 104, 235, 491, 459]);

function step31(s, w, onUnsupported) {
    const xoFull = XO(w);
    // Bit 10 is part of the 10-bit XO field of X-form instructions, but is the
    // OE bit of XO-form instructions. Distinguish them the way the hardware
    // encoding does: an XO-form instruction's field equals (9-bit XO) | OE<<9.
    const xo = (xoFull & 0x200) !== 0 && XO_FORM.has(xoFull & 0x1ff) ? xoFull & 0x1ff : xoFull;
    const d = RT(w);
    const a = s.gpr[RA(w)];
    const b = s.gpr[RB(w)];
    const ca = (s.xer & XER_CA) !== 0;
    // Logical, shift and unary instructions use rS = RT(w) as the source and
    // rA = RA(w) as the destination, the opposite field order of the
    // arithmetic (rD = RT(w), rA = RA(w)) instructions.
    const src = s.gpr[RT(w)];

    switch (xo) {
        case 266: { // add
            s.gpr[d] = u32(a + b);
            if (OE(w)) setOV(s, addOverflowed(a, b, s.gpr[d]));
            break;
        }
        case 10: { // addc
            const t = BigInt(a) + BigInt(b);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            setCarry(s, t > 0xffffffffn);
            if (OE(w)) setOV(s, addOverflowed(a, b, s.gpr[d]));
            break;
        }
        case 138: { // adde
            const t = BigInt(a) + BigInt(b) + (ca ? 1n : 0n);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            setCarry(s, t > 0xffffffffn);
            if (OE(w)) setOV(s, addOverflowed(a, b, s.gpr[d]));
            break;
        }
        case 234: { // addme
            const t = BigInt(a) + 0xffffffffn + (ca ? 1n : 0n);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            setCarry(s, t > 0xffffffffn);
            if (OE(w)) setOV(s, addOverflowed(a, 0xffffffff, s.gpr[d]));
            break;
        }
        case 202: { // addze
            const t = BigInt(a) + (ca ? 1n : 0n);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            setCarry(s, t > 0xffffffffn);
            if (OE(w)) setOV(s, addOverflowed(a, 0, s.gpr[d]));
            break;
        }
        case 40: { // subf: rD = rB - rA
            const t = BigInt(b) - BigInt(a);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            if (OE(w)) setOV(s, addOverflowed(u32(~a), b, s.gpr[d]));
            break;
        }
        case 8: { // subfc
            const t = BigInt(b) - BigInt(a);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            setCarry(s, t >= 0n);
            if (OE(w)) setOV(s, addOverflowed(u32(~a), b, s.gpr[d]));
            break;
        }
        case 136: { // subfe
            const t = BigInt(b) - BigInt(a) - (ca ? 0n : 1n);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            setCarry(s, t >= 0n);
            if (OE(w)) setOV(s, addOverflowed(u32(~a), b, s.gpr[d]));
            break;
        }
        case 232: { // subfme
            const t = BigInt(u32(~a)) + 0xffffffffn + (ca ? 1n : 0n);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            setCarry(s, t > 0xffffffffn);
            if (OE(w)) setOV(s, addOverflowed(u32(~a), 0xffffffff, s.gpr[d]));
            break;
        }
        case 200: { // subfze
            const t = BigInt(u32(~a)) + (ca ? 1n : 0n);
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            setCarry(s, t > 0xffffffffn);
            if (OE(w)) setOV(s, addOverflowed(u32(~a), 0, s.gpr[d]));
            break;
        }
        case 104: { // neg: CA is not touched
            s.gpr[d] = u32(0 - a);
            // The references agree: OV is set only for the most negative value.
            if (OE(w)) setOV(s, a === 0x80000000);
            break;
        }
        case 235: { // mullw
            const t = BigInt(s32(a)) * BigInt(s32(b));
            s.gpr[d] = u32(Number(t & 0xffffffffn));
            if (OE(w)) setOV(s, t !== BigInt(s32(s.gpr[d])));
            break;
        }
        case 75: s.gpr[d] = u32(Number((BigInt(s32(a)) * BigInt(s32(b))) >> 32n)); break;
        case 11: s.gpr[d] = u32(Number((BigInt(a) * BigInt(b)) >> 32n)); break;
        case 491: { // divw
            const sa = s32(a);
            const sb = s32(b);
            const overflow = sb === 0 || (u32(sa) === 0x80000000 && sb === -1);
            if (overflow) s.gpr[d] = sa < 0 ? 0xffffffff : 0;
            else s.gpr[d] = u32(Math.trunc(sa / sb));
            if (OE(w)) setOV(s, overflow);
            break;
        }
        case 459: { // divwu
            const overflow = b === 0;
            s.gpr[d] = overflow ? 0 : Math.trunc(u32(a) / u32(b));
            if (OE(w)) setOV(s, overflow);
            break;
        }
        case 28: s.gpr[RA(w)] = u32(src & b); break;
        case 60: s.gpr[RA(w)] = u32(src & ~b); break;
        case 444: s.gpr[RA(w)] = u32(src | b); break;
        case 412: s.gpr[RA(w)] = u32(src | ~b); break;
        case 316: s.gpr[RA(w)] = u32(src ^ b); break;
        case 476: s.gpr[RA(w)] = u32(~(src & b)); break;
        case 124: s.gpr[RA(w)] = u32(~(src | b)); break;
        case 284: s.gpr[RA(w)] = u32(~(src ^ b)); break;
        case 24: { // slw
            const n = b & 63;
            s.gpr[RA(w)] = n > 31 ? 0 : u32(src << n);
            break;
        }
        case 536: { // srw
            const n = b & 63;
            s.gpr[RA(w)] = n > 31 ? 0 : u32(src >>> n);
            break;
        }
        case 792: { // sraw
            const n = b & 63;
            let car;
            if (n > 31) {
                car = (src >>> 31) !== 0;
                s.gpr[RA(w)] = car ? 0xffffffff : 0;
            } else {
                s.gpr[RA(w)] = u32(s32(src) >> n);
                car = n !== 0 && (src >>> 31) !== 0 && u32(src << (32 - n)) !== 0;
            }
            setCarry(s, car);
            break;
        }
        case 824: { // srawi
            const n = SH(w);
            s.gpr[RA(w)] = u32(s32(src) >> n);
            setCarry(s, n !== 0 && (src >>> 31) !== 0 && u32(src << (32 - n)) !== 0);
            break;
        }
        case 26: { // cntlzw
            let n = 0;
            while (n < 32 && ((src >>> (31 - n)) & 1) === 0) n++;
            s.gpr[RA(w)] = n;
            break;
        }
        case 954: s.gpr[RA(w)] = u32(s32((src << 24) >> 24)); break;
        case 922: s.gpr[RA(w)] = u32(s32((src << 16) >> 16)); break;
        case 0: { // cmp
            const sb = s32(b);
            setCRFromCompare(s, CRF(w), s32(a) < sb, s32(a) > sb, s32(a) === sb);
            break;
        }
        case 32: setCRFromCompare(s, CRF(w), a < b, a > b, a === b); break;
        case 4: break; // tw: the harness stub records a trap and continues
        case 339: case 371: { // mfspr/mftb
            s.gpr[d] = mfspr(s, SPR(w));
            break;
        }
        case 467: mtspr(s, SPR(w), s.gpr[d]); break;
        case 19: s.gpr[d] = s.cr; break;
        case 144: { // mtcrf: CRM bit 0 (the field MSB) selects CR field 0
            const fm = (w >>> 12) & 0xff;
            let m = 0;
            for (let i = 0; i < 8; i++) if (fm & (0x80 >> i)) m = u32(m | (0xf << (28 - 4 * i)));
            s.cr = u32((s.cr & ~m) | (s.gpr[RT(w)] & m));
            break;
        }
        case 23: s.gpr[d] = rd32(s, xEA(s, w)); return;
        case 55: { const ea = xEA(s, w); s.gpr[RA(w)] = ea; s.gpr[d] = rd32(s, ea); return; }
        case 87: s.gpr[d] = rd8(s, xEA(s, w)); return;
        case 119: { const ea = xEA(s, w); s.gpr[RA(w)] = ea; s.gpr[d] = rd8(s, ea); return; }
        case 279: s.gpr[d] = rd16(s, xEA(s, w)); return;
        case 343: s.gpr[d] = u32(s32((rd16(s, xEA(s, w)) << 16) >> 16)); return;
        case 311: { const ea = xEA(s, w); s.gpr[RA(w)] = ea; s.gpr[d] = u32(s32((rd16(s, ea) << 16) >> 16)); return; }
        case 151: wr32(s, xEA(s, w), s.gpr[RT(w)]); return;
        case 183: { const ea = xEA(s, w); wr32(s, ea, s.gpr[RT(w)]); s.gpr[RA(w)] = ea; return; }
        case 215: wr8(s, xEA(s, w), s.gpr[RT(w)]); return;
        case 247: { const ea = xEA(s, w); wr8(s, ea, s.gpr[RT(w)]); s.gpr[RA(w)] = ea; return; }
        case 407: wr16(s, xEA(s, w), s.gpr[RT(w)]); return;
        case 439: { const ea = xEA(s, w); wr16(s, ea, s.gpr[RT(w)]); s.gpr[RA(w)] = ea; return; }
        case 534: { // lwbrx: byte-reversed load = little-endian host read
            const ea = xEA(s, w);
            s.gpr[d] = u32(rd8(s, ea) | (rd8(s, ea + 1) << 8) | (rd8(s, ea + 2) << 16) | (rd8(s, ea + 3) << 24));
            return;
        }
        case 662: { // stwbrx
            const ea = xEA(s, w);
            const v = s.gpr[RT(w)];
            wr8(s, ea, v & 0xff);
            wr8(s, ea + 1, (v >>> 8) & 0xff);
            wr8(s, ea + 2, (v >>> 16) & 0xff);
            wr8(s, ea + 3, (v >>> 24) & 0xff);
            return;
        }
        case 597: { // lswi
            const n = RB(w) === 0 ? 32 : RB(w);
            const ea = RA(w) === 0 ? 0 : s.gpr[RA(w)];
            let r = (RT(w) - 1) & 31;
            for (let i = 0; i < n; i++) {
                if ((i & 3) === 0) {
                    r = (r + 1) & 31;
                    s.gpr[r] = 0;
                }
                s.gpr[r] = u32(s.gpr[r] | (rd8(s, ea + i) << (24 - 8 * (i & 3))));
            }
            return;
        }
        case 725: { // stswi
            const n = RB(w) === 0 ? 32 : RB(w);
            const ea = RA(w) === 0 ? 0 : s.gpr[RA(w)];
            let r = (RT(w) - 1) & 31;
            for (let i = 0; i < n; i++) {
                if ((i & 3) === 0) r = (r + 1) & 31;
                wr8(s, ea + i, (s.gpr[r] >>> (24 - 8 * (i & 3))) & 0xff);
            }
            return;
        }
        case 20: { // lwarx
            const ea = xEA(s, w);
            s.resv = ea;
            s.gpr[d] = rd32(s, ea);
            return;
        }
        case 150: { // stwcx.
            const ea = xEA(s, w);
            const ok = s.resv === ea;
            if (ok) wr32(s, ea, s.gpr[RT(w)]);
            s.resv = 0xffffffff;
            setCRField(s, 0, (ok ? 2 : 0) | crSO(s));
            return;
        }
        case 598: case 854: return; // sync/lwsync/eieio: no architectural state
        case 54: case 86: return; // dcbst/dcbf
        case 1014: { // dcbz
            const ea = xEA(s, w) & ~31;
            for (let i = 0; i < 32; i++) wr8(s, ea + i, 0);
            return;
        }
        default:
            unsupported(onUnsupported, `op31-xo${xo}`, w);
    }
    if (RC(w)) {
        if (RA_RESULT.has(xo)) setCR0(s, s.gpr[RA(w)]);
        else if (RT_RESULT.has(xo)) setCR0(s, s.gpr[d]);
    }
}

/* XO/X-form Rc updates CR0 from rD = RT(w). */
const RT_RESULT = new Set([
    266, 10, 138, 234, 202, 40, 8, 136, 232, 200, 104, 235, 75, 11, 491, 459,
]);

/* Logical/shift/unary Rc updates CR0 from rA = RA(w). */
const RA_RESULT = new Set([28, 60, 444, 412, 316, 476, 124, 284, 24, 536, 792, 824, 26, 954, 922]);

function mfspr(s, spr) {
    switch (spr) {
        case 1: return s.xer;
        case 8: return s.lr;
        case 9: return s.ctr;
        default: return 0;
    }
}

function mtspr(s, spr, v) {
    switch (spr) {
        case 1: s.xer = u32(v); break;
        case 8: s.lr = u32(v); break;
        case 9: s.ctr = u32(v); break;
        default: break;
    }
}

/* ------------------------------------------------------------------ */
/* Program evaluation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Runs `words` with the given initial state and returns the report lines in
 * exactly the format tests/isa/run.js makes the compiled C print.
 */
function evaluate(caseDef) {
    const s = newState();
    const init = caseDef.init || {};
    if (init.gpr) for (const [k, v] of Object.entries(init.gpr)) s.gpr[k >>> 0] = u32(v);
    if (init.xer !== undefined) s.xer = u32(init.xer);
    if (init.cr !== undefined) s.cr = u32(init.cr);
    if (init.lr !== undefined) s.lr = u32(init.lr);
    if (init.ctr !== undefined) s.ctr = u32(init.ctr);
    for (const ch of caseDef.mem || []) {
        const bytes = Buffer.from(ch.hex, "hex");
        for (let i = 0; i < bytes.length; i++) s.mem[ch.addr + i] = bytes[i];
    }

    const unsupported = [];
    // Single basic block: run the words in order until the program returns.
    for (const w of caseDef.prog) {
        if (u32(w) === 0x4e800020) break; // blr terminates the single basic block
        step(s, u32(w), (what, word) => unsupported.push(`${what}@${u32(word).toString(16)}`));
    }
    if (unsupported.length) throw new Error(`oracle does not model: ${unsupported.join(", ")}`);

    const lines = [];
    lines.push(`gpr ${Array.from(s.gpr).map((v) => v.toString(16).padStart(8, "0")).join(" ")}`);
    lines.push(
        `xer ${s.xer.toString(16).padStart(8, "0")} cr ${s.cr.toString(16).padStart(8, "0")} ` +
            `lr ${s.lr.toString(16).padStart(8, "0")} ctr ${s.ctr.toString(16).padStart(8, "0")}`
    );
    for (const { addr, len } of caseDef.dump || []) {
        let hex = "";
        for (let i = 0; i < len; i++) hex += s.mem[addr + i].toString(16).padStart(2, "0");
        lines.push(`mem ${addr.toString(16).padStart(8, "0")} ${hex}`);
    }
    return lines;
}

module.exports = {
    ARENA,
    maskBits,
    rotl32,
    s32,
    u32,
    evaluate,
    buildCases: require("./cases.js").buildCases,
};
