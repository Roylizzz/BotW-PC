"use strict";

/**
 * Original PowerPC instruction decoder for the tools in this repository.
 *
 * Scope: the instruction set used by Wii U game code (Espresso / Broadway /
 * Gekko heritage): the integer core, the scalar floating-point unit, the
 * paired-single extensions (the Wii U CPU has no AltiVec) and branch
 * handling. Instructions outside the currently supported set are decoded
 * structurally (opcode at least) and reported as unsupported so that
 * coverage can be measured across the whole binary.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

// ---------------------------------------------------------------------------
// Field extraction helpers (bit 0 is the least significant bit).
// ---------------------------------------------------------------------------

const OP = (w) => (w >>> 26) & 0x3f; // primary opcode (bits 26..31)
const RT = (w) => (w >>> 21) & 0x1f; // target/source register (bits 21..25)
const RS = RT;
const RA = (w) => (w >>> 16) & 0x1f;
const RB = (w) => (w >>> 11) & 0x1f;
const FRC = (w) => (w >>> 6) & 0x1f; // A-form C source (bits 6..10)
const XO10 = (w) => (w >>> 1) & 0x3ff; // 10-bit extended opcode (bits 1..10)
const XO5 = (w) => (w >>> 1) & 0x1f; // 5-bit extended opcode (bits 1..5)
const RC_BIT = (w) => (w & 1) === 1; // record bit
const LK_BIT = (w) => (w & 1) === 1; // link bit (branches)
const OE_BIT = (w) => ((w >>> 10) & 1) === 1; // overflow-enable bit
const SIMM = (w) => (w << 16) >> 16; // signed 16-bit immediate
const UIMM = (w) => w & 0xffff;
const CRF = (w) => (w >>> 23) & 0x7; // CR field number (bits 23..25)
const L_BIT31 = (w) => (w >>> 10) & 1; // bit 10 (compare width, lwarx EH)
const SPR = (w) => (((w >>> 11) & 0x1f) << 5) | ((w >>> 16) & 0x1f);
const BO = (w) => (w >>> 21) & 0x1f;
const BI = (w) => (w >>> 16) & 0x1f;
const TO = (w) => (w >>> 21) & 0x1f; // trap condition field (tw)
/* BD (bc): byte displacement in bits 2..15; bits 1-0 are AA/LK and must be
 * masked off before sign-extending from bit 15. */
const BD_SIGN = (w) => {
    const x = w & 0xfffc;
    return x & 0x8000 ? x - 0x10000 : x;
};
/* LI (b/bl): byte displacement in bits 2..25, sign-extended from bit 25. */
const LI_SIGN = (w) => {
    const x = w & 0x03fffffc;
    return x & 0x02000000 ? x - 0x04000000 : x;
};
const SH = (w) => (w >>> 11) & 0x1f;
const MB = (w) => (w >>> 6) & 0x1f;
const ME = (w) => (w >>> 1) & 0x1f;
const FM = (w) => (w >>> 12) & 0xff; // mtcrf CRM mask (bits 12..19)
const TBR = SPR;

// ---------------------------------------------------------------------------
// Decode tables
// ---------------------------------------------------------------------------

const D_FORM = new Set([7, 8, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29]);
const D_FORM_NAME = {
    7: "mulli",
    8: "subfic",
    10: "cmpli",
    11: "cmpi",
    12: "addic",
    13: "addic.",
    14: "addi",
    15: "addis",
    24: "ori",
    25: "oris",
    26: "xori",
    27: "xoris",
    28: "andi.",
    29: "andis.",
};

const LOADSTORE = {
    32: { name: "lwz", kind: "load", access: "u32" },
    33: { name: "lwzu", kind: "load", access: "u32", update: true },
    34: { name: "lbz", kind: "load", access: "u8" },
    35: { name: "lbzu", kind: "load", access: "u8", update: true },
    36: { name: "stw", kind: "store", access: "u32" },
    37: { name: "stwu", kind: "store", access: "u32", update: true },
    38: { name: "stb", kind: "store", access: "u8" },
    39: { name: "stbu", kind: "store", access: "u8", update: true },
    40: { name: "lhz", kind: "load", access: "u16" },
    41: { name: "lhzu", kind: "load", access: "u16", update: true },
    42: { name: "lha", kind: "load", access: "s16" },
    43: { name: "lhau", kind: "load", access: "s16", update: true },
    44: { name: "sth", kind: "store", access: "u16" },
    45: { name: "sthu", kind: "store", access: "u16", update: true },
    46: { name: "lmw", kind: "load-multi" },
    47: { name: "stmw", kind: "store-multi" },
    48: { name: "lfs", kind: "load", access: "f32" },
    49: { name: "lfsu", kind: "load", access: "f32", update: true },
    50: { name: "lfd", kind: "load", access: "f64" },
    51: { name: "lfdu", kind: "load", access: "f64", update: true },
    52: { name: "stfs", kind: "store", access: "f32" },
    53: { name: "stfsu", kind: "store", access: "f32", update: true },
    54: { name: "stfd", kind: "store", access: "f64" },
    55: { name: "stfdu", kind: "store", access: "f64", update: true },
};

// opcode 31: X-form and XO-form
const X31 = {
    // arithmetic (XO-form; OE bit at 10, Rc at 0)
    266: { name: "add" },
    10: { name: "addc" },
    138: { name: "adde" },
    234: { name: "addme" },
    202: { name: "addze" },
    40: { name: "subf" },
    8: { name: "subfc" },
    136: { name: "subfe" },
    232: { name: "subfme" },
    200: { name: "subfze" },
    104: { name: "neg" },
    235: { name: "mullw" },
    75: { name: "mulhw" },
    11: { name: "mulhwu" },
    491: { name: "divw" },
    459: { name: "divwu" },
    // logical
    28: { name: "and" },
    60: { name: "andc" },
    444: { name: "or" },
    412: { name: "orc" },
    316: { name: "xor" },
    476: { name: "nand" },
    124: { name: "nor" },
    284: { name: "eqv" },
    // shifts
    24: { name: "slw" },
    536: { name: "srw" },
    792: { name: "sraw" },
    824: { name: "srawi", shift: true },
    // unary
    26: { name: "cntlzw" },
    954: { name: "extsb" },
    922: { name: "extsh" },
    // compares
    0: { name: "cmp", compare: "signed" },
    32: { name: "cmpl", compare: "unsigned" },
    // trap
    4: { name: "tw", trap: true },
    // SPR access
    339: { name: "mfspr", spr: true },
    467: { name: "mtspr", spr: true },
    371: { name: "mftb", spr: true },
    19: { name: "mfcr" },
    144: { name: "mtcrf", crMask: true },
    // memory (X-form)
    23: { name: "lwzx", kind: "load", access: "u32" },
    55: { name: "lwzux", kind: "load", access: "u32", update: true },
    87: { name: "lbzx", kind: "load", access: "u8" },
    119: { name: "lbzux", kind: "load", access: "u8", update: true },
    279: { name: "lhzx", kind: "load", access: "u16" },
    311: { name: "lhaux", kind: "load", access: "s16", update: true },
    343: { name: "lhax", kind: "load", access: "s16" },
    151: { name: "stwx", kind: "store", access: "u32" },
    183: { name: "stwux", kind: "store", access: "u32", update: true },
    215: { name: "stbx", kind: "store", access: "u8" },
    247: { name: "stbux", kind: "store", access: "u8", update: true },
    407: { name: "sthx", kind: "store", access: "u16" },
    439: { name: "sthux", kind: "store", access: "u16", update: true },
    534: { name: "lwbrx", kind: "load", access: "host32" },
    790: { name: "lhbrx", kind: "load", access: "host16" },
    662: { name: "stwbrx", kind: "store", access: "host32" },
    918: { name: "sthbrx", kind: "store", access: "host16" },
    // FP store of the integer in the low word
    983: { name: "stfiwx", kind: "store", access: "fpu-lo32" },
    // indexed floating point (X-form): lwzx/stwx shape with FPR targets
    535: { name: "lfsx", kind: "load", access: "f32" },
    567: { name: "lfsux", kind: "load", access: "f32", update: true },
    599: { name: "lfdx", kind: "load", access: "f64" },
    631: { name: "lfdux", kind: "load", access: "f64", update: true },
    663: { name: "stfsx", kind: "store", access: "f32" },
    695: { name: "stfsux", kind: "store", access: "f32", update: true },
    727: { name: "stfdx", kind: "store", access: "f64" },
    759: { name: "stfdux", kind: "store", access: "f64", update: true },
    // string load/store (NB in the RB field; 0 means 32 bytes)
    597: { name: "lswi", kind: "string-load" },
    725: { name: "stswi", kind: "string-store" },
    // reservation
    20: { name: "lwarx", kind: "lwarx" },
    150: { name: "stwcx.", kind: "stwcx" },
    // cache / barriers
    598: { name: "sync" },
    854: { name: "eieio" },
    86: { name: "dcbf" },
    54: { name: "dcbst" },
    1014: { name: "dcbz" },
};

// opcode 19: XL-form
const X19 = {
    16: { name: "bclr", branch: "bclr" },
    528: { name: "bcctr", branch: "bcctr" },
    0: { name: "mcrf" },
    33: { name: "crnor" },
    129: { name: "crandc" },
    193: { name: "crxor" },
    225: { name: "crnand" },
    257: { name: "crand" },
    289: { name: "creqv" },
    417: { name: "crorc" },
    449: { name: "cror" },
    150: { name: "isync" },
};

// A-form floating point (opcode 63: double, opcode 59: single)
const FPA63 = {
    18: "fdiv",
    20: "fsub",
    21: "fadd",
    22: "fsqrt",
    23: "fsel",
    25: "fmul",
    26: "frsqrte",
    28: "fmsub",
    29: "fmadd",
    30: "fnmsub",
    31: "fnmadd",
};
const FPA59 = {
    18: "fdivs",
    20: "fsubs",
    21: "fadds",
    22: "fsqrts",
    24: "fres",
    25: "fmuls",
    26: "frsqrtes",
    28: "fmsubs",
    29: "fmadds",
    30: "fnmsubs",
    31: "fnmadds",
};

// X-form floating point (opcode 63 only)
const FPX63 = {
    0: "fcmpu",
    12: "frsp",
    14: "fctiw",
    15: "fctiwz",
    32: "fcmpo",
    40: "fneg",
    72: "fmr",
    136: "fnabs",
    264: "fabs",
    814: "fctid",
    815: "fctidz",
    846: "fcfid",
};

// Paired-single, opcode 4.
// A-form variants use a 5-bit XO (bits 1..5); the X-form variants use a
// 10-bit XO (bits 1..10). The two sets can never collide because no A-form
// XO value is congruent (mod 32) to any X-form XO value.
const PS_A = {
    10: "ps_sum0",
    11: "ps_sum1",
    12: "ps_muls0",
    13: "ps_muls1",
    14: "ps_madds0",
    15: "ps_madds1",
    18: "ps_div",
    20: "ps_sub",
    21: "ps_add",
    23: "ps_sel",
    25: "ps_mul",
    28: "ps_msub",
    29: "ps_madd",
    30: "ps_nmsub",
    31: "ps_nmadd",
};
const PS_X = {
    0: "ps_cmpu0",
    24: "ps_res",
    26: "ps_rsqrte",
    32: "ps_cmpo0",
    40: "ps_neg",
    64: "ps_cmpu1",
    72: "ps_mr",
    96: "ps_cmpo1",
    136: "ps_nabs",
    264: "ps_abs",
    528: "ps_merge00",
    560: "ps_merge01",
    592: "ps_merge10",
    624: "ps_merge11",
};

// Quantized paired-single load/store (unsupported for now).
const PSQ = {
    56: { name: "psq_l" },
    57: { name: "psq_lu", update: true },
    60: { name: "psq_st" },
    61: { name: "psq_stu", update: true },
};

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Decodes one 32-bit big-endian instruction word.
 * `supported: false` marks instructions the translator does not implement
 * yet; they are still named where possible so coverage reports are useful.
 */
function decode(word) {
    const w = word >>> 0;
    const op = OP(w);
    const base = { word: w, op };

    if (w === 0) return { ...base, name: "invalid-0", supported: false, invalid: true };
    if (w === 0x4e800020) return { ...base, name: "blr", supported: true, branch: "blr" };
    if (w === 0x4e800420) return { ...base, name: "bctr", supported: true, branch: "bctr" };

    // --- D-form ---
    if (D_FORM.has(op)) {
        const name = D_FORM_NAME[op];
        if (name === "ori" && RT(w) === 0 && RA(w) === 0 && UIMM(w) === 0) {
            return { ...base, name: "nop", supported: true, form: "D" };
        }
        const d = {
            ...base,
            name,
            form: "D",
            rt: RT(w),
            ra: RA(w),
            imm: SIMM(w),
            uimm: UIMM(w),
            supported: true,
        };
        if (name === "cmpi" || name === "cmpli") d.crf = CRF(w);
        return d;
    }

    // --- loads / stores (D-form) ---
    if (LOADSTORE[op]) {
        const info = LOADSTORE[op];
        const isFloat = info.access === "f32" || info.access === "f64";
        const d = {
            ...base,
            name: info.name,
            form: "D",
            ra: RA(w),
            imm: SIMM(w),
            kind: info.kind,
            access: info.access,
            update: !!info.update,
            supported: true,
        };
        if (isFloat) d.frd = RT(w);
        else d.rt = RT(w);
        return d;
    }

    // --- rotate and mask ---
    if (op === 20 || op === 21 || op === 23) {
        const names = { 20: "rlwimi", 21: "rlwinm", 23: "rlwnm" };
        return {
            ...base,
            name: names[op],
            form: "M",
            rs: RS(w),
            ra: RA(w),
            rb: op === 23 ? RB(w) : undefined,
            sh: SH(w),
            mb: MB(w),
            me: ME(w),
            rc: RC_BIT(w),
            supported: true,
        };
    }

    // --- branches ---
    if (op === 18) {
        const lk = LK_BIT(w);
        return {
            ...base,
            name: lk ? "bl" : "b",
            form: "I",
            li: LI_SIGN(w),
            aa: (w >>> 1) & 1,
            lk,
            branch: lk ? "bl" : "b",
            supported: true,
        };
    }
    if (op === 16) {
        return {
            ...base,
            name: "bc",
            form: "B",
            bo: BO(w),
            bi: BI(w),
            bd: BD_SIGN(w),
            aa: (w >>> 1) & 1,
            branch: "bc",
            supported: true,
        };
    }

    // --- opcode 19 (XL) ---
    if (op === 19) {
        const xo = XO10(w);
        const info = X19[xo];
        if (!info) return { ...base, name: `op19-xo${xo}`, supported: false, unknownOpcode: true };
        if (info.branch) {
            return {
                ...base,
                name: info.name,
                form: "XL",
                bo: BO(w),
                bi: BI(w),
                bh: (w >>> 11) & 3,
                lk: LK_BIT(w),
                branch: info.branch,
                supported: true,
            };
        }
        if (info.name === "isync") return { ...base, name: "isync", form: "XL", supported: true };
        if (info.name === "mcrf") return { ...base, name: "mcrf", form: "XL", crfd: CRF(w), crfs: (w >>> 16) & 0x7, supported: true };
        return {
            ...base,
            name: info.name,
            form: "XL",
            crfd: (w >>> 21) & 0x1f,
            crfa: (w >>> 16) & 0x1f,
            crfb: (w >>> 11) & 0x1f,
            supported: true,
        };
    }

    // --- opcode 31 ---
    if (op === 31) {
        const xo = XO10(w);
        const info = X31[xo];
        if (!info) return { ...base, name: `op31-xo${xo}`, supported: false, unknownOpcode: true };

        if (info.trap) {
            return { ...base, name: "tw", form: "X", to: TO(w), ra: RA(w), rb: RB(w), supported: true };
        }
        if (info.compare) {
            return {
                ...base,
                name: info.name,
                form: "X",
                crf: CRF(w),
                ra: RA(w),
                rb: RB(w),
                l: L_BIT31(w),
                supported: true,
            };
        }
        if (info.spr) {
            return { ...base, name: info.name, form: "XFX", rt: RT(w), ra: RA(w), spr: SPR(w), supported: true };
        }
        if (info.name === "mfcr") return { ...base, name: "mfcr", form: "X", rt: RT(w), supported: true };
        if (info.name === "mtcrf") return { ...base, name: "mtcrf", form: "XFX", rs: RS(w), fm: FM(w), supported: true };
        if (info.kind === "load" || info.kind === "store") {
            const d = {
                ...base,
                name: info.name,
                form: "X",
                rt: info.kind === "load" ? RT(w) : RS(w),
                ra: RA(w),
                rb: RB(w),
                kind: info.kind,
                access: info.access,
                update: !!info.update,
                supported: true,
            };
            if (info.access === "f32" || info.access === "f64") d.frd = RT(w);
            return d;
        }
        if (info.kind === "string-load" || info.kind === "string-store") {
            return {
                ...base,
                name: info.name,
                form: "X",
                rt: RT(w),
                ra: RA(w),
                nb: RB(w),
                rc: RC_BIT(w),
                supported: true,
            };
        }
        if (info.kind === "lwarx") {
            return { ...base, name: "lwarx", form: "X", rt: RT(w), ra: RA(w), rb: RB(w), supported: true };
        }
        if (info.kind === "stwcx") {
            return { ...base, name: "stwcx.", form: "X", rs: RS(w), ra: RA(w), rb: RB(w), supported: true };
        }
        if (info.name === "sync") {
            /* L field of sync lives at bit 21 (lwsync = sync | 0x00200000). */
            const l = (w >>> 21) & 1;
            return { ...base, name: l ? "lwsync" : "sync", form: "X", supported: true };
        }
        if (info.name === "eieio") return { ...base, name: "eieio", form: "X", supported: true };
        if (info.name === "dcbf" || info.name === "dcbst" || info.name === "dcbz") {
            return { ...base, name: info.name, form: "X", ra: RA(w), rb: RB(w), supported: true };
        }
        // register-form arithmetic / logical / shift / unary
        return {
            ...base,
            name: info.name,
            form: "XO",
            rt: RT(w),
            ra: RA(w),
            rb: RB(w),
            sh: SH(w),
            rc: RC_BIT(w),
            oe: OE_BIT(w),
            supported: true,
        };
    }

    // --- floating point ---
    if (op === 63 || op === 59) {
        const single = op === 59;
        const xo5 = XO5(w);
        const nameA = single ? FPA59[xo5] : FPA63[xo5];
        if (nameA) {
            return {
                ...base,
                name: nameA,
                form: "A",
                frd: RT(w),
                fra: RA(w),
                frb: RB(w),
                frc: FRC(w),
                rc: RC_BIT(w),
                supported: true,
            };
        }
        if (single) return { ...base, name: `op59-xo${xo5}`, supported: false, unknownOpcode: true };
        const xo10 = XO10(w);
        const nameX = FPX63[xo10];
        if (nameX) {
            const d = { ...base, name: nameX, form: "X", frd: RT(w), frb: RB(w), rc: RC_BIT(w) };
            if (nameX === "fcmpu" || nameX === "fcmpo") {
                d.crf = CRF(w);
                d.fra = RA(w);
                d.frb = RB(w);
            } else {
                d.fra = RA(w);
            }
            d.supported = nameX !== "fctid";
            return d;
        }
        return { ...base, name: `op63-xo${xo10}`, supported: false, unknownOpcode: true };
    }

    // --- paired single ---
    if (op === 4) {
        const xo10 = XO10(w);
        const nameX = PS_X[xo10];
        if (nameX) {
            const d = { ...base, name: nameX, form: "X", frd: RT(w), frb: RB(w), fra: RA(w), rc: RC_BIT(w) };
            if (nameX.startsWith("ps_cmp")) d.crf = CRF(w);
            d.supported = true;
            return d;
        }
        const xo5 = XO5(w);
        const nameA = PS_A[xo5];
        if (nameA) {
            return {
                ...base,
                name: nameA,
                form: "A",
                frd: RT(w),
                fra: RA(w),
                frb: RB(w),
                frc: FRC(w),
                rc: RC_BIT(w),
                supported: true,
            };
        }
        return { ...base, name: `op4-xo${xo10}`, supported: false, unknownOpcode: true };
    }

    // --- quantized paired-single load/store ---
    if (PSQ[op]) {
        const info = PSQ[op];
        return {
            ...base,
            name: info.name,
            form: "PSQ",
            frd: RT(w),
            ra: RA(w),
            w: (w >>> 15) & 1,
            i: (w >>> 12) & 7,
            update: !!info.update,
            supported: false,
        };
    }

    return { ...base, name: `op${op}`, supported: false, unknownOpcode: true };
}

module.exports = {
    decode,
    OP,
    RT,
    RS,
    RA,
    RB,
    FRC,
    XO10,
    XO5,
    RC_BIT,
    LK_BIT,
    SIMM,
    UIMM,
    CRF,
    SPR,
    BO,
    BI,
    TO,
    BD_SIGN,
    LI_SIGN,
    SH,
    MB,
    ME,
    TBR,
};
