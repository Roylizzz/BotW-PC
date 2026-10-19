#ifndef PPCX_ABI_H
#define PPCX_ABI_H

/**
 * ppcx ABI: the small C runtime interface generated code is compiled
 * against.
 *
 * Everything here is original to the BotW-PC project (MIT). The generated
 * code (produced locally from the user's own game dump by tools/ppcx) is
 * never part of this repository.
 *
 * Memory model
 * ------------
 * Guest memory is a flat 32-bit address space mapped at a fixed host base.
 * The guest is big-endian; all accessors below byte-swap. Unaligned access
 * is always handled byte-wise.
 *
 * CPU model
 * ---------
 * One `Cpu` per guest CPU context (thread). GPRs are plain 32-bit values.
 * `PpcxFpr` uses the register model of the reference PowerPC emulator used
 * while developing this project: `ps0` holds the scalar/double view of the
 * register (and its raw 64 bits) while `ps1` holds the second paired-single
 * lane. Scalar single-precision instructions fill both lanes with the same
 * value, exactly like the hardware behaviour that model reproduces.
 *
 * See the fidelity notes on each helper for the deliberately-simplified
 * parts of this first iteration (FPSCR flags, Gekko "1.5" quirks,
 * quantization, atomic reservations).
 */

#include <stdint.h>
#include <stddef.h> /* size_t for guest pointer offsets */
#include <math.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef uint64_t u64;
typedef int8_t s8;
typedef int16_t s16;
typedef int32_t s32;
typedef int64_t s64;

#ifndef PPCX_GUEST_BASE
#define PPCX_GUEST_BASE 0x200000000000ull
#endif

/*
 * Size of the flat guest arena the runtime allocates for guest memory. The
 * RPX modules this prototype supports link all their sections below
 * 0xC2000000 (the import slot tables sit at 0xC0000000), which keeps the
 * whole image inside one host allocation.
 */
#define PPCX_ARENA_BYTES 0xC2000000u

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------ */
/* CPU state                                                          */
/* ------------------------------------------------------------------ */

typedef union PpcxWord {
    double d; /* value view (double) */
    u64 u;    /* raw 64-bit view     */
} PpcxWord;

typedef struct PpcxFpr {
    PpcxWord ps0; /* scalar/double view; on hardware: the full register  */
    PpcxWord ps1; /* second paired-single lane (hardware: low 32 bits)   */
} PpcxFpr;

typedef struct Cpu {
    u32 gpr[32];
    PpcxFpr fpr[32];
    u32 cr;  /* 32 bits; CR0 occupies bits 28..31 */
    u32 lr, ctr, xer;
    u32 resv; /* address reserved by the last lwarx */
    u32 sr[16];
    u64 tb; /* time base, advanced by the runtime */
    u32 sprs[8];
    u32 gqr[8]; /* SPR 912..919: graphics quantization registers */
    u32 hid2;   /* SPR 920: LSQE (bit 31) gates the psq_* instructions */
} Cpu;

#define PPCX_XER_SO 0x80000000u
#define PPCX_XER_OV 0x40000000u
#define PPCX_XER_CA 0x20000000u

/* HID2 (SPR 920): LSQE, load/store quantization enable. The boot environment
 * must leave it set for the psq_* instructions to execute. */
#define PPCX_HID2_LSQE 0x80000000u

/* ------------------------------------------------------------------ */
/* Guest memory access                                                */
/* ------------------------------------------------------------------ */

/*
 * Guest memory is a flat 32-bit address space. The runtime allocates the
 * arena once (see ppcx_runtime_init) so that guest addresses stay exactly
 * the addresses the game was linked for.
 *
 * Every accessor goes through the checked path: once the runtime installs a
 * region map (ppcx_mem_reset, see ppcx_mem.h) an access that does not fall
 * entirely inside one mapped region, or a write to a region registered
 * without PPCX_MEM_WRITE, fails deterministically (diagnostic on stderr,
 * exit code 9) instead of silently touching unrelated arena bytes.
 * Harnesses that never install a map keep the raw flat-address behavior.
 */
extern u8 *ppcx_memory;

/* Region-map state, implemented in ppcx_mem.c (see ppcx_mem.h). */
extern int ppcx_mem_active;
void ppcx_mem_check(u32 ea, unsigned size, unsigned write);

static inline u8 *ppcx_ptr(u32 ea) {
    return ppcx_memory + (size_t)ea;
}

static inline u8 *ppcx_ptr_checked(u32 ea, unsigned size, unsigned write) {
    if (ppcx_mem_active) ppcx_mem_check(ea, size, write);
    return ppcx_memory + (size_t)ea;
}

static inline u32 ppcx_rd32(u32 ea) {
    const u8 *p = ppcx_ptr_checked(ea, 4, 0);
    return ((u32)p[0] << 24) | ((u32)p[1] << 16) | ((u32)p[2] << 8) | (u32)p[3];
}

static inline u16 ppcx_rd16(u32 ea) {
    const u8 *p = ppcx_ptr_checked(ea, 2, 0);
    return (u16)(((u32)p[0] << 8) | (u32)p[1]);
}

static inline u8 ppcx_rd8(u32 ea) { return *ppcx_ptr_checked(ea, 1, 0); }

static inline void ppcx_wr32(u32 ea, u32 v) {
    u8 *p = ppcx_ptr_checked(ea, 4, 1);
    p[0] = (u8)(v >> 24);
    p[1] = (u8)(v >> 16);
    p[2] = (u8)(v >> 8);
    p[3] = (u8)v;
}

static inline void ppcx_wr16(u32 ea, u16 v) {
    u8 *p = ppcx_ptr_checked(ea, 2, 1);
    p[0] = (u8)(v >> 8);
    p[1] = (u8)v;
}

static inline void ppcx_wr8(u32 ea, u8 v) { *ppcx_ptr_checked(ea, 1, 1) = v; }

static inline u64 ppcx_rd64(u32 ea) {
    const u8 *p = ppcx_ptr_checked(ea, 8, 0);
    u64 v = 0;
    for (int i = 0; i < 8; i++) v = (v << 8) | p[i];
    return v;
}

static inline void ppcx_wr64(u32 ea, u64 v) {
    u8 *p = ppcx_ptr_checked(ea, 8, 1);
    for (int i = 0; i < 8; i++) p[7 - i] = (u8)(v >> (8 * i));
}

/* Byte-reversed loads/stores (lwbrx family) read/write host order. */
static inline u32 ppcx_rd32_host(u32 ea) { return *(const u32 *)(const void *)ppcx_ptr_checked(ea, 4, 0); }
static inline u16 ppcx_rd16_host(u32 ea) { return *(const u16 *)(const void *)ppcx_ptr_checked(ea, 2, 0); }
static inline void ppcx_wr32_host(u32 ea, u32 v) { *(u32 *)(void *)ppcx_ptr_checked(ea, 4, 1) = v; }
static inline void ppcx_wr16_host(u32 ea, u16 v) { *(u16 *)(void *)ppcx_ptr_checked(ea, 2, 1) = v; }

/*
 * Multiple-register load/store (lmw/stmw). The effective address is passed
 * in already evaluated: as on hardware, writing the base register inside the
 * transferred range does not change the addresses used by the remainder.
 */
static inline void ppcx_lmw(Cpu *c, u32 ea, u32 rt) {
    u32 n;
    for (n = rt; n < 32u; n++) {
        c->gpr[n] = ppcx_rd32(ea);
        ea += 4u;
    }
}

static inline void ppcx_stmw(Cpu *c, u32 ea, u32 rs) {
    u32 n;
    for (n = rs; n < 32u; n++) {
        ppcx_wr32(ea, c->gpr[n]);
        ea += 4u;
    }
}

/*
 * String load/store (lswi/stswi). The byte stream advances one register per
 * 4-byte group (not per byte): byte 0 of a group goes to/from bits 24..31 of
 * the register and the rest move to lower bit positions; a final partial
 * group leaves the remaining byte positions zero (load) and is not read
 * (store). Register numbers wrap from r31 to r0 and NB = 0 moves 32 bytes.
 * This matches the reference interpreter's lswi/stswi loops.
 */
static inline void ppcx_lswi(Cpu *c, u32 ea, u32 rt, u32 nb) {
    const u32 n = nb ? nb : 32u;
    u32 r = (rt - 1u) & 31u;
    for (u32 i = 0; i < n; i++) {
        if ((i & 3u) == 0u) {
            r = (r + 1u) & 31u;
            c->gpr[r] = 0u;
        }
        c->gpr[r] |= (u32)ppcx_rd8(ea) << (24u - 8u * (i & 3u));
        ea += 1u;
    }
}

static inline void ppcx_stswi(Cpu *c, u32 ea, u32 rs, u32 nb) {
    const u32 n = nb ? nb : 32u;
    u32 r = (rs - 1u) & 31u;
    for (u32 i = 0; i < n; i++) {
        if ((i & 3u) == 0u) r = (r + 1u) & 31u;
        ppcx_wr8(ea, (u8)(c->gpr[r] >> (24u - 8u * (i & 3u))));
        ea += 1u;
    }
}

static inline float ppcx_bits_f32(u32 bits) {
    union { u32 u; float f; } v;
    v.u = bits;
    return v.f;
}

static inline u32 ppcx_f32_bits(float f) {
    union { u32 u; float f; } v;
    v.f = f;
    return v.u;
}

/* ------------------------------------------------------------------ */
/* Single-precision representation helpers                            */
/* ------------------------------------------------------------------ */

/*
 * Store of a single-precision value: converts the 64-bit register pattern to
 * the 32-bit single pattern using the algorithm from the PowerPC programming
 * environments manual (the same one the reference emulator implements,
 * including its handling of doubles that round into the subnormal single
 * range). All helpers of this file keep register values as the exact double
 * of a single, so this conversion is exact in practice.
 */
static inline u32 ppcx_single_bits_from_bits(u64 x) {
    const u32 exp = (u32)((x >> 52) & 0x7ffu);
    if (exp > 896u || (x & ~0x8000000000000000ull) == 0ull) {
        return (u32)(((x >> 32) & 0xc0000000ull) | ((x >> 29) & 0x3fffffffull));
    }
    if (exp >= 874u) {
        u32 t = 0x80000000u | (u32)((x & 0x000fffffffffffffull) >> 21);
        t >>= (905u - exp);
        t |= (u32)((x >> 32) & 0x80000000u);
        return t;
    }
    return (u32)(((x >> 32) & 0xc0000000ull) | ((x >> 29) & 0x3fffffffull));
}

/*
 * The same conversion with the flush-to-zero behavior the reference emulator
 * applies to float-typed psq_st stores: doubles strictly inside the
 * single-subnormal range store a sign-only zero.
 */
static inline u32 ppcx_single_bits_from_bits_ftz(u64 x) {
    const u32 exp = (u32)((x >> 52) & 0x7ffu);
    if (exp > 896u || (x & ~0x8000000000000000ull) == 0ull) {
        return (u32)(((x >> 32) & 0xc0000000ull) | ((x >> 29) & 0x3fffffffull));
    }
    return (u32)((x >> 32) & 0x80000000ull);
}

/*
 * FIDELITY NOTE (Phase 3): the hardware also keeps singles in the "1.5
 * format" in the upper register half, and single FMA instructions round only
 * once from a wider internal precision with quirks the reference emulator
 * documents at length. This iteration reproduces value-level behaviour:
 * doubles are computed from the exact values of the operands and rounded
 * once to single via `(float)` / fmaf-style helpers.
 */
#define PPCX_PS0(fr) ((float)((fr).ps0.d))
#define PPCX_PS1(fr) ((float)((fr).ps1.d))
#define PPCX_SET_PS2(fr, v0, v1) \
    do {                       \
        (fr).ps0.d = (double)(v0); \
        (fr).ps1.d = (double)(v1); \
    } while (0)
#define PPCX_FILL_SINGLE(fr, v) PPCX_SET_PS2(fr, v, v)

/* ------------------------------------------------------------------ */
/* Condition register helpers                                         */
/* ------------------------------------------------------------------ */

static inline void ppcx_cr_set_hex(Cpu *c, u32 crf, u32 v) {
    u32 sh = 28u - 4u * crf;
    c->cr = (c->cr & ~(0xfu << sh)) | ((v & 0xfu) << sh);
}

static inline void ppcx_cr_set(Cpu *c, u32 crf, int lt, int gt, int eq, int so) {
    u32 v = ((u32)(lt != 0) << 3) | ((u32)(gt != 0) << 2) | ((u32)(eq != 0) << 1) | (u32)(so != 0);
    ppcx_cr_set_hex(c, crf, v);
}

static inline u32 ppcx_cr_field(const Cpu *c, u32 crf) {
    return (c->cr >> (28u - 4u * crf)) & 0xfu;
}

/*
 * Full BO/BI branch-condition evaluation (ISA table 12-5):
 *   BO[0]=0x10: 1 = ignore CR
 *   BO[1]=0x08: 1 = branch if CR[BI] true (when CR is tested)
 *   BO[2]=0x04: 0 = decrement CTR and test it
 *   BO[3]=0x02: with BO[2]=0: 1 = branch if CTR == 0, else branch if CTR != 0
 * BO = 20 (0b10100) is "branch always" and leaves CTR alone.
 */
static inline int ppcx_bc(Cpu *c, u32 bo, u32 bi) {
    int cond = 1;
    if (!(bo & 0x10u)) {
        u32 bit = (c->cr >> (31u - bi)) & 1u;
        cond = (bo & 0x08u) ? (int)bit : (int)(bit ^ 1u);
    }
    if (!(bo & 0x04u)) {
        u32 n = c->ctr - 1u;
        c->ctr = n;
        cond = cond && ((bo & 0x02u) ? (n == 0u) : (n != 0u));
    }
    return cond;
}

/* Single CR bit access (bit number as encoded in BI/crfa fields). */
static inline u32 ppcx_cr_bit(const Cpu *c, u32 bit) { return (c->cr >> (31u - bit)) & 1u; }

static inline void ppcx_cr_setbit(Cpu *c, u32 bit, u32 v) {
    u32 m = 1u << (31u - bit);
    c->cr = (c->cr & ~m) | ((v & 1u) << (31u - bit));
}

/* ------------------------------------------------------------------ */
/* Integer helpers (exact 32-bit wrap-around semantics)               */
/* ------------------------------------------------------------------ */

static inline u32 ppcx_rotl32(u32 v, u32 n) {
    n &= 31u;
    return n ? ((v << n) | (v >> (32u - n))) : v;
}

/*
 * Rotation mask for rlwinm/rlwimi/rlwnm: ones from bit MB through bit ME,
 * counted from the most significant bit, wrapping through bit 31 back to
 * bit 0. This is the construction the reference emulator uses; a bit-by-bit
 * model of the ISA definition agrees with it for all 1024 (MB, ME) pairs
 * while the previous rotate-by-MB form was wrong for 962 of them.
 */
static inline u32 ppcx_mask_mb_me(u32 mb, u32 me) {
    const u32 begin = 0xffffffffu >> (mb & 31u);
    const u32 end = 0x7fffffffu >> (me & 31u);
    const u32 mask = begin ^ end;
    return ((me & 31u) < (mb & 31u)) ? ~mask : mask;
}

static inline u32 ppcx_rlwinm(u32 v, u32 sh, u32 mb, u32 me) {
    return ppcx_rotl32(v, sh) & ppcx_mask_mb_me(mb, me);
}

static inline u32 ppcx_rlwimi(u32 orig, u32 v, u32 sh, u32 mb, u32 me) {
    u32 m = ppcx_mask_mb_me(mb, me);
    return (orig & ~m) | (ppcx_rotl32(v, sh) & m);
}

static inline u32 ppcx_slw(u32 v, u32 n) {
    n &= 63u;
    return (n > 31u) ? 0u : (v << n);
}

static inline u32 ppcx_srw(u32 v, u32 n) {
    n &= 63u;
    return (n > 31u) ? 0u : (v >> n);
}

/*
 * sraw/srawi. Value and carry follow the ISA: the carry bit is set only when
 * the value is negative and a non-zero bit is shifted out; shift amounts of
 * zero never set CA, and amounts of 32..63 produce the sign fill with
 * CA = sign of the value.
 */
static inline void ppcx_sraw(Cpu *c, u32 d, u32 v, u32 n) {
    n &= 63u;
    int ca;
    if (n > 31u) {
        ca = (v >> 31) != 0u;
        c->gpr[d] = ca ? 0xffffffffu : 0u;
    } else {
        c->gpr[d] = (u32)(((s32)v) >> n);
        ca = n != 0u && (v >> 31) != 0u && ((v << (32u - n)) != 0u);
    }
    c->xer = (c->xer & ~PPCX_XER_CA) | (ca ? PPCX_XER_CA : 0u);
}

static inline void ppcx_srawi(Cpu *c, u32 d, u32 v, u32 sh) {
    c->gpr[d] = (u32)(((s32)v) >> sh);
    const int ca = sh != 0u && (v >> 31) != 0u && ((v << (32u - sh)) != 0u);
    c->xer = (c->xer & ~PPCX_XER_CA) | (ca ? PPCX_XER_CA : 0u);
}

static inline u32 ppcx_cntlzw(u32 v) {
    if (v == 0u) return 32u;
#if defined(__GNUC__) || defined(__clang__)
    return (u32)__builtin_clz(v);
#else
    u32 n = 0;
    while (!(v & 0x80000000u)) { v <<= 1; n++; }
    return n;
#endif
}

static inline u32 ppcx_sext8(u32 v) { return (u32)(s32)(s8)v; }
static inline u32 ppcx_sext16(u32 v) { return (u32)(s32)(s16)v; }

static inline void ppcx_cr0(Cpu *c, u32 v) {
    s32 s = (s32)v;
    ppcx_cr_set(c, 0, s < 0, s > 0, v == 0, (c->xer & PPCX_XER_SO) != 0);
}

static inline void ppcx_cmp(Cpu *c, u32 crf, u32 a, u32 b) {
    s32 sa = (s32)a, sb = (s32)b;
    ppcx_cr_set(c, crf, sa < sb, sa > sb, sa == sb, (c->xer & PPCX_XER_SO) != 0);
}

static inline void ppcx_cmpl(Cpu *c, u32 crf, u32 a, u32 b) {
    ppcx_cr_set(c, crf, a < b, a > b, a == b, (c->xer & PPCX_XER_SO) != 0);
}

/*
 * tw: trap word. When any selected condition holds the guest would take a
 * program exception; in this prototype the runtime reports it with a
 * register dump and stops (implemented in ppcx_runtime.c). TO bit names as
 * in the ISA: 0x10 signed less, 0x08 signed greater, 0x04 equal,
 * 0x02 unsigned less, 0x01 unsigned greater.
 */
extern void ppcx_trap(Cpu *c, u32 addr, const char *name);

static inline void ppcx_tw(Cpu *c, u32 to, u32 a, u32 b, u32 addr) {
    s32 sa = (s32)a, sb = (s32)b;
    int hit = ((to & 0x10u) && sa < sb) ||
              ((to & 0x08u) && sa > sb) ||
              ((to & 0x04u) && sa == sb) ||
              ((to & 0x02u) && a < b) ||
              ((to & 0x01u) && a > b);
    if (hit) ppcx_trap(c, addr, "tw");
}

static inline u32 ppcx_crm_mask(u32 fm) {
    u32 m = 0;
    for (u32 i = 0; i < 8; i++) {
        if (fm & (0x80u >> i)) m |= 0xfu << (28u - 4u * i);
    }
    return m;
}

static inline void ppcx_mtcrf(Cpu *c, u32 v, u32 fm) {
    u32 m = ppcx_crm_mask(fm);
    c->cr = (c->cr & ~m) | (v & m);
}

/* add/subtract with carry; subf* helpers implement rD = rB - rA. */
static inline void ppcx_addc(Cpu *c, u32 d, u32 a, u32 b) {
    u64 t = (u64)a + (u64)b;
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_adde(Cpu *c, u32 d, u32 a, u32 b) {
    u64 t = (u64)a + (u64)b + ((c->xer & PPCX_XER_CA) ? 1u : 0u);
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_addme(Cpu *c, u32 d, u32 a) {
    u64 t = (u64)a + 0xffffffffull + ((c->xer & PPCX_XER_CA) ? 1u : 0u);
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_addze(Cpu *c, u32 d, u32 a) {
    u64 t = (u64)a + ((c->xer & PPCX_XER_CA) ? 1u : 0u);
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_subfc(Cpu *c, u32 d, u32 ra, u32 rb) {
    u64 t = (u64)(~ra) + (u64)rb + 1ull; /* rb - ra */
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_subfe(Cpu *c, u32 d, u32 ra, u32 rb) {
    u64 t = (u64)(~ra) + (u64)rb + ((c->xer & PPCX_XER_CA) ? 1ull : 0ull);
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_subfme(Cpu *c, u32 d, u32 ra) {
    u64 t = (u64)(~ra) + 0xffffffffull + ((c->xer & PPCX_XER_CA) ? 1ull : 0ull);
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_subfze(Cpu *c, u32 d, u32 ra) {
    u64 t = (u64)(~ra) + ((c->xer & PPCX_XER_CA) ? 1ull : 0ull);
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_addic(Cpu *c, u32 d, u32 a, u32 imm) {
    u64 t = (u64)a + (u64)imm;
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

static inline void ppcx_subfic(Cpu *c, u32 d, u32 a, u32 imm) {
    u64 t = (u64)imm + (u64)(~a) + 1ull;
    c->gpr[d] = (u32)t;
    c->xer = (c->xer & ~PPCX_XER_CA) | ((t >> 32) ? PPCX_XER_CA : 0u);
}

/*
 * neg: value only. The ISA does not update XER.CA for neg (the reference
 * interpreter leaves CA untouched), so neither do we.
 */
static inline void ppcx_neg(Cpu *c, u32 d, u32 a) {
    c->gpr[d] = (u32)(0u - a);
}

/*
 * XER overflow support for the OE form of the XO instructions. Writing OV
 * also accumulates the sticky summary-overflow bit (SO = SO | OV), which is
 * what hardware does.
 */
static inline void ppcx_set_ov(Cpu *c, int ov) {
    if (ov) c->xer |= PPCX_XER_OV | PPCX_XER_SO;
    else c->xer &= ~PPCX_XER_OV;
}

/*
 * Overflow test for the add/subtract family: overflow happens when both
 * operands have the same sign and the result has the opposite one.
 */
static inline int ppcx_ov_add(u32 x, u32 y, u32 result) {
    return (((x ^ result) & (y ^ result)) >> 31) != 0u;
}

/*
 * Divide instructions. The ISA leaves divide-by-zero results undefined;
 * the values below match the two reference implementations of this CPU
 * family (which agree with each other). The `oe` parameter mirrors the
 * instruction's OE bit: it reports the overflow through XER.OV/SO.
 */
static inline void ppcx_divw(Cpu *c, u32 d, u32 a, u32 b, int oe) {
    const s32 sa = (s32)a, sb = (s32)b;
    const int overflow = (sb == 0) || (a == 0x80000000u && sb == -1);
    if (overflow) c->gpr[d] = (sa < 0) ? 0xffffffffu : 0u;
    else c->gpr[d] = (u32)(sa / sb);
    if (oe) ppcx_set_ov(c, overflow);
}

static inline void ppcx_divwu(Cpu *c, u32 d, u32 a, u32 b, int oe) {
    const int overflow = (b == 0u);
    c->gpr[d] = overflow ? 0u : (a / b);
    if (oe) ppcx_set_ov(c, overflow);
}

/*
 * lwarx/stwcx.: a first-iteration reservation model. Single-threaded code
 * (all Phase 2 tests) observes exact behaviour; true cross-thread atomicity
 * is a Phase 3 task (see the runtime README).
 */
static inline u32 ppcx_lwarx(Cpu *c, u32 ea) {
    c->resv = ea;
    return ppcx_rd32(ea);
}

static inline int ppcx_stwcx(Cpu *c, u32 ea, u32 v) {
    int ok = (c->resv == ea);
    if (ok) ppcx_wr32(ea, v);
    c->resv = 0xffffffffu;
    ppcx_cr_set(c, 0, 0, 0, ok, (c->xer & PPCX_XER_SO) != 0);
    return ok;
}

/* SPR access. SPRs used by the 32-bit PowerPC instruction set. */
static inline u32 ppcx_mfspr(Cpu *c, u32 spr) {
    switch (spr) {
    case 1: return c->xer;
    case 8: return c->lr;
    case 9: return c->ctr;
    case 22: return 0; /* DEC: not modelled yet */
    case 26: case 27: return 0; /* SRR0/SRR1: not modelled yet */
    case 268: return (u32)c->tb;
    case 269: return (u32)(c->tb >> 32);
    case 272: case 273: case 274: case 275: return c->sprs[spr - 272];
    case 287: return 0x70010200u; /* PVR: Espresso (value to verify) */
    default:
        if (spr >= 912u && spr <= 919u) return c->gqr[spr - 912u];
        if (spr == 920u) return c->hid2;
        return 0;
    }
}

static inline void ppcx_mtspr(Cpu *c, u32 spr, u32 v) {
    switch (spr) {
    case 1: c->xer = v; break;
    case 8: c->lr = v; break;
    case 9: c->ctr = v; break;
    case 272: case 273: case 274: case 275: c->sprs[spr - 272] = v; break;
    default:
        if (spr >= 912u && spr <= 919u) c->gqr[spr - 912u] = v;
        else if (spr == 920u) c->hid2 = v;
        break;
    }
}

/* ------------------------------------------------------------------ */
/* Floating-point helpers                                             */
/* ------------------------------------------------------------------ */

/* fsel/ps_sel: select C if A >= -0.0, else B (NaN selects B). */
static inline double ppcx_fsel(double a, double b, double c) {
    return (a >= -0.0) ? c : b;
}

static inline float ppcx_fsel_s(float a, float b, float c) {
    return (a >= -0.0f) ? c : b;
}

/*
 * Fused multiply-add. `PPCX_NO_FMA` exists for toolchains whose C library
 * lacks fma/fmaf (the local prototype compiler); the fallback computes the
 * same value with one extra rounding, which only shows up on rare inputs.
 */
#ifdef PPCX_NO_FMA
static inline double ppcx_fma_d(double a, double c, double b) { return a * c + b; }
static inline float ppcx_fma_s(double a, double c, double b) { return (float)(a * c + b); }
#else
static inline double ppcx_fma_d(double a, double c, double b) { return fma(a, c, b); }
static inline float ppcx_fma_s(double a, double c, double b) { return (float)fma(a, c, b); }
#endif

static inline double ppcx_neg_unless_nan_d(double x) { return isnan(x) ? x : -x; }
static inline float ppcx_neg_unless_nan_s(float x) { return isnan(x) ? x : -x; }

/*
 * Reciprocal and reciprocal-square-root estimates (fres/frsqrte/frsqrtes
 * and the ps_* forms).
 *
 * FIDELITY NOTE (Phase 3): real hardware returns a 12-bit table estimate
 * refined from the operand's low bits; this iteration computes the exact
 * result instead. Sequences that refine the estimate with Newton-Raphson
 * converge to the same value; code that inspects the estimate bits directly
 * would see differences.
 */
static inline double ppcx_res_d(double b) { return 1.0 / b; }

static inline double ppcx_rsqrte_d(double b) {
    if (isnan(b)) return b;
    if (b < 0.0) return NAN;
    return 1.0 / sqrt(b);
}

/*
 * FP compare. CR field value: 8 = less, 4 = greater, 2 = equal, 1 =
 * unordered (the FU bit lands in the SO position, as reproduced by the
 * reference model). The ordered/unordered distinction only affects FPSCR
 * exception flags, which this iteration does not model.
 */
static inline void ppcx_fcmp(Cpu *c, u32 crf, double a, double b) {
    u32 v;
    if (isnan(a) || isnan(b)) v = 1u;
    else if (a < b) v = 8u;
    else if (a > b) v = 4u;
    else v = 2u;
    ppcx_cr_set_hex(c, crf, v);
}

static inline void ppcx_ps_cmp(Cpu *c, u32 crf, double a, double b) {
    u32 v;
    if (isnan(a) || isnan(b)) v = 1u;
    else if (a < b) v = 8u;
    else if (a > b) v = 4u;
    else v = 2u;
    ppcx_cr_set_hex(c, crf, v);
}

/* fctiw/fctiwz result pattern (0xFFF80000 in the high half). */

/*
 * Portable truncation and round-half-to-even: the runtime must not depend
 * on the C99 library functions `trunc`/`nearbyint`, which some prototype
 * toolchains (the local TCC build, using the system C runtime) lack.
 */
static inline double ppcx_trunc_d(double x) {
    return (x >= 0.0) ? floor(x) : ceil(x);
}

static inline double ppcx_nearbyint_d(double x) {
    double r = floor(x);
    double diff = x - r;
    if (diff > 0.5) r += 1.0;
    else if (diff == 0.5 && (r / 2.0) != floor(r / 2.0)) r += 1.0;
    return r;
}

static inline u64 ppcx_fctiw_result(double b, int truncate) {
    double rounded = truncate ? ppcx_trunc_d(b) : ppcx_nearbyint_d(b);
    u32 value;
    if (isnan(b)) {
        value = 0x80000000u;
    } else if (rounded >= 2147483648.0) {
        value = 0x7fffffffu;
    } else if (rounded < -2147483648.0) {
        value = 0x80000000u;
    } else {
        value = (u32)(s32)rounded;
    }
    u64 result = 0xfff8000000000000ull | (u64)value;
    if (value == 0u && signbit(b)) result |= 0x100000000ull;
    return result;
}

static inline u64 ppcx_fctidz_result(double v) {
    if (isnan(v)) return 0x8000000000000000ull;
    {
        double t = ppcx_trunc_d(v);
        if (t >= 9223372036854775808.0) return 0x7fffffffffffffffull;
        if (t < -9223372036854775808.0) return 0x8000000000000000ull;
        return (u64)(s64)t;
    }
}

/* ------------------------------------------------------------------ */
/* Quantized paired-single load/store (psq_l/psq_st family)           */
/* ------------------------------------------------------------------ */

/*
 * GQR layout (Gekko/Broadway/Espresso; field positions as in the reference
 * emulator and the homebrew references): ST_TYPE bits 0..2, ST_SCALE bits
 * 8..13, LD_TYPE bits 16..18, LD_SCALE bits 24..29.
 *
 * Quantize types: 0 float, 1..3 invalid, 4 u8, 5 u16, 6 s8, 7 s16. The
 * scale fields are signed 6-bit values: a load multiplies by 2^-scale, a
 * store by 2^scale, both in single precision.
 *
 * HID2.LSQE (bit 31) gates the family. The reference emulator only checks it
 * on the D-form variants; this model gates all of them, per the
 * architecture description.
 */
static inline u32 ppcx_gqr_ld_type(u32 gqr) { return (gqr >> 16) & 7u; }
static inline u32 ppcx_gqr_ld_scale(u32 gqr) { return (gqr >> 24) & 63u; }
static inline u32 ppcx_gqr_st_type(u32 gqr) { return gqr & 7u; }
static inline u32 ppcx_gqr_st_scale(u32 gqr) { return (gqr >> 8) & 63u; }

static inline int ppcx_gqr_signed_scale(u32 scale6) {
    return (scale6 >= 32u) ? (int)scale6 - 64 : (int)scale6;
}

/* 2^s as an exact single for s in [-32, 32]. */
static inline float ppcx_gqr_pow2(int s) {
    union { u32 u; float f; } v;
    v.u = (u32)(s + 127) << 23;
    return v.f;
}

/*
 * Reference dequantization: float(raw) * 2^-scale. Exact here: the raw value
 * fits in a single and the factor is a power of two.
 */
static inline double ppcx_gqr_dequant(s32 raw, int scale) {
    return (double)((float)raw * ppcx_gqr_pow2(-scale));
}

/*
 * Reference quantization: float(ps) * 2^scale, clamped to the type range and
 * truncated toward zero. A NaN operand is undefined in the reference; this
 * model maps it to the minimum of the range.
 */
static inline s32 ppcx_gqr_quant(double ps, int scale, s32 lo, s32 hi) {
    const float conv = (float)ps * ppcx_gqr_pow2(scale);
    if (!(conv >= (float)lo)) return lo;
    if (conv > (float)hi) return hi;
    return (s32)conv;
}

/* psq_l/psq_lu/psq_lx/psq_lux: load and dequantize into FPR `frd`. */
static inline void ppcx_psq_l(Cpu *c, u32 ea, u32 i, u32 w, u32 frd, u32 addr) {
    const u32 gqr = c->gqr[i & 7u];
    const u32 type = ppcx_gqr_ld_type(gqr);
    const int scale = ppcx_gqr_signed_scale(ppcx_gqr_ld_scale(gqr));
    double ps0 = 0.0;
    double ps1 = 0.0;
    if ((c->hid2 & PPCX_HID2_LSQE) == 0u) {
        ppcx_trap(c, addr, "psq_l without HID2.LSQE");
        return;
    }
    switch (type) {
    case 0: /* float: exact single -> double widening */
        ps0 = (double)ppcx_bits_f32(ppcx_rd32(ea));
        ps1 = w ? 1.0 : (double)ppcx_bits_f32(ppcx_rd32(ea + 4u));
        break;
    case 4: /* u8 */
        if (w) {
            ps0 = ppcx_gqr_dequant((s32)ppcx_rd8(ea), scale);
            ps1 = 1.0;
        } else {
            const u16 pair = ppcx_rd16(ea);
            ps0 = ppcx_gqr_dequant((s32)(u8)(pair >> 8), scale);
            ps1 = ppcx_gqr_dequant((s32)(u8)pair, scale);
        }
        break;
    case 5: /* u16 */
        if (w) {
            ps0 = ppcx_gqr_dequant((s32)ppcx_rd16(ea), scale);
            ps1 = 1.0;
        } else {
            const u32 pair = ppcx_rd32(ea);
            ps0 = ppcx_gqr_dequant((s32)(u16)(pair >> 16), scale);
            ps1 = ppcx_gqr_dequant((s32)(u16)pair, scale);
        }
        break;
    case 6: /* s8 */
        if (w) {
            ps0 = ppcx_gqr_dequant((s32)(s8)ppcx_rd8(ea), scale);
            ps1 = 1.0;
        } else {
            const u16 pair = ppcx_rd16(ea);
            ps0 = ppcx_gqr_dequant((s32)(s8)(u8)(pair >> 8), scale);
            ps1 = ppcx_gqr_dequant((s32)(s8)(u8)pair, scale);
        }
        break;
    case 7: /* s16 */
        if (w) {
            ps0 = ppcx_gqr_dequant((s32)(s16)ppcx_rd16(ea), scale);
            ps1 = 1.0;
        } else {
            const u32 pair = ppcx_rd32(ea);
            ps0 = ppcx_gqr_dequant((s32)(s16)(u16)(pair >> 16), scale);
            ps1 = ppcx_gqr_dequant((s32)(s16)(u16)pair, scale);
        }
        break;
    default:
        /* Types 1..3 are invalid: the reference leaves both lanes zero. */
        break;
    }
    c->fpr[frd & 31u].ps0.d = ps0;
    c->fpr[frd & 31u].ps1.d = ps1;
}

/* psq_st/psq_stu/psq_stx/psq_stux: quantize FPR `frs` and store. */
static inline void ppcx_psq_st(Cpu *c, u32 ea, u32 i, u32 w, u32 frs, u32 addr) {
    const u32 gqr = c->gqr[i & 7u];
    const u32 type = ppcx_gqr_st_type(gqr);
    const int scale = ppcx_gqr_signed_scale(ppcx_gqr_st_scale(gqr));
    const double ps0 = c->fpr[frs & 31u].ps0.d;
    const double ps1 = c->fpr[frs & 31u].ps1.d;
    if ((c->hid2 & PPCX_HID2_LSQE) == 0u) {
        ppcx_trap(c, addr, "psq_st without HID2.LSQE");
        return;
    }
    switch (type) {
    case 0: /* float: FTZ (stores a signed zero in the subnormal range) */
        ppcx_wr32(ea, ppcx_single_bits_from_bits_ftz(c->fpr[frs & 31u].ps0.u));
        if (!w) ppcx_wr32(ea + 4u, ppcx_single_bits_from_bits_ftz(c->fpr[frs & 31u].ps1.u));
        break;
    case 4: { /* u8 */
        const s32 a = ppcx_gqr_quant(ps0, scale, 0, 255);
        if (w) ppcx_wr8(ea, (u8)a);
        else {
            const s32 b = ppcx_gqr_quant(ps1, scale, 0, 255);
            ppcx_wr16(ea, (u16)(((u32)a << 8) | (u32)b));
        }
        break;
    }
    case 5: { /* u16 */
        const s32 a = ppcx_gqr_quant(ps0, scale, 0, 65535);
        if (w) ppcx_wr16(ea, (u16)a);
        else {
            const s32 b = ppcx_gqr_quant(ps1, scale, 0, 65535);
            ppcx_wr32(ea, ((u32)a << 16) | (u32)b);
        }
        break;
    }
    case 6: { /* s8 */
        const s32 a = ppcx_gqr_quant(ps0, scale, -128, 127);
        if (w) ppcx_wr8(ea, (u8)(a & 0xff));
        else {
            const s32 b = ppcx_gqr_quant(ps1, scale, -128, 127);
            ppcx_wr16(ea, (u16)(((u32)(a & 0xff) << 8) | (u32)(b & 0xff)));
        }
        break;
    }
    case 7: { /* s16 */
        const s32 a = ppcx_gqr_quant(ps0, scale, -32768, 32767);
        if (w) ppcx_wr16(ea, (u16)(a & 0xffff));
        else {
            const s32 b = ppcx_gqr_quant(ps1, scale, -32768, 32767);
            ppcx_wr32(ea, ((u32)(a & 0xffff) << 16) | (u32)(b & 0xffff));
        }
        break;
    }
    default:
        /* Types 1..3 are invalid: the reference does not store. */
        break;
    }
}

/* ------------------------------------------------------------------ */
/* Barriers / cache                                                   */
/* ------------------------------------------------------------------ */

#if defined(__GNUC__) || defined(__clang__)
#define PPCX_FENCE_SYNC() __atomic_thread_fence(__ATOMIC_SEQ_CST)
#define PPCX_FENCE_LWSYNC() __atomic_thread_fence(__ATOMIC_ACQ_REL)
#define PPCX_FENCE_EIEIO() __atomic_thread_fence(__ATOMIC_SEQ_CST)
#define PPCX_FENCE_ISYNC() __atomic_thread_fence(__ATOMIC_ACQUIRE)
#else
#define PPCX_FENCE_SYNC() ((void)0)
#define PPCX_FENCE_LWSYNC() ((void)0)
#define PPCX_FENCE_EIEIO() ((void)0)
#define PPCX_FENCE_ISYNC() ((void)0)
#endif

static inline void ppcx_dcbz(u32 ea) {
    u8 *p = ppcx_ptr_checked(ea & ~31u, 32, 1);
    for (int i = 0; i < 32; i++) p[i] = 0;
}

/* ------------------------------------------------------------------ */
/* Trampolines into the runtime                                       */
/* ------------------------------------------------------------------ */

/* Registry entry for one translated function (generated into gen.c). */
typedef struct PpcxEntry {
    u32 addr;
    void (*fn)(Cpu *);
} PpcxEntry;

/* High-level emulation of an imported system function (by stable index
 * assigned by `ppcx imports`). */
extern void ppcx_hle_call(Cpu *c, u32 import_index);

/* Guest address of the trampoline that represents an imported function
 * when its address is taken by the game. */
extern u32 ppcx_import_addr(u32 import_index);

/* Indirect branch target resolution (bctr/bclr and friends). */
extern void ppcx_dispatch(Cpu *c, u32 target);

/* Reached the end of translated coverage. */
extern void ppcx_unimpl(Cpu *c, u32 addr);

extern void ppcx_call_unknown(Cpu *c, u32 target);

/*
 * Records the entry of a translated function for debugging. Trace builds of
 * the generated code call this once per function entry; PPCX_FN_TRACE=1
 * makes it print every entry and PPCX_CRASH_TRACE=1 (Windows) uses the ring
 * to dump the most recent entries when the host takes an access violation.
 */
extern void ppcx_trace_enter(u32 addr);

#define PPCX_HLE(c, idx) ppcx_hle_call((c), (idx))
#define PPCX_IMPORT_ADDR(idx) ppcx_import_addr((idx))
#define PPCX_DISPATCH(c, target) ppcx_dispatch((c), (target))
#define PPCX_UNIMPL(c, addr) ppcx_unimpl((c), (addr))
#define PPCX_CALL_UNKNOWN(c, target) ppcx_call_unknown((c), (target))

/* Tail call to another translated function. Clang can turn this into a real
 * tail call with musttail; other compilers fall back to a call + return. */
#define PPCX_TAILCALL(c, fn) \
    do {                     \
        (fn)((c));           \
        return;              \
    } while (0)

#ifdef __cplusplus
}
#endif

#endif /* PPCX_ABI_H */
