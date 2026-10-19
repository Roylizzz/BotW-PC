/* Source-owned synthetic test for explicit Cafe OS HLE dispatch (MIT).
 *
 * The contract test runs on a raw host arena: ppcx_mem_active stays 0 and
 * ppcx_mem_check is a stub here. The compiled memory harness (tests/mem)
 * exercises the same models with the real region map and expects the
 * read-only/unmapped faults to stop the process. */
#include "ppcx_hle.h"
#include <stdio.h>
#include <string.h>

static u8 arena[0x1000];
u8 *ppcx_memory;
int ppcx_mem_active = 0;

void ppcx_mem_check(u32 ea, unsigned size, unsigned write) {
    (void)ea;
    (void)size;
    (void)write;
}

static int fail(const char *message) {
    fprintf(stderr, "hle: %s\n", message);
    return 1;
}

static int test_identity(void) {
    static const struct {
        const char *name;
        u32 result;
    } known[] = {
        { "coreinit.OSGetCoreCount", 3u },
        { "coreinit.OSGetCoreId", 1u },
        { "coreinit.OSGetMainCoreId", 1u },
        { "coreinit.OSIsMainCore", 1u },
    };
    Cpu cpu;
    Cpu before;
    unsigned i;
    for (i = 0; i < sizeof(known) / sizeof(known[0]); i++) {
        memset(&cpu, 0x5a, sizeof cpu);
        cpu.gpr[3] = 0xdeadbeefu;
        before = cpu;
        if (ppcx_hle_dispatch_named(&cpu, known[i].name) != 1) return fail("known import unresolved");
        if (cpu.gpr[3] != known[i].result) return fail("incorrect return value in r3");
        before.gpr[3] = known[i].result;
        if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("unintended register mutation");
    }
    return 0;
}

static int test_block_move(void) {
    Cpu cpu;
    Cpu before;
    unsigned char pattern[16];
    unsigned i;

    for (i = 0; i < 16; i++) {
        pattern[i] = (u8)(0x40u + i);
        arena[0x100 + i] = pattern[i];
    }
    memset(arena + 0x200, 0xee, sizeof pattern);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x200u;
    cpu.gpr[4] = 0x100u;
    cpu.gpr[5] = 16u;
    cpu.gpr[6] = 1u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMove") != 1) return fail("OSBlockMove unresolved");
    before.gpr[3] = 0x200u;
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("OSBlockMove changed unexpected registers");
    if (memcmp(arena + 0x200, pattern, sizeof pattern) != 0) return fail("OSBlockMove copied wrong bytes");

    /* wut documents memmove semantics: overlapping source/destination. */
    for (i = 0; i < 8; i++) arena[0x300 + i] = (u8)i;
    memset(arena + 0x308, 0xee, 4);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x304u;
    cpu.gpr[4] = 0x300u;
    cpu.gpr[5] = 8u;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMove") != 1) return fail("OSBlockMove overlap unresolved");
    for (i = 0; i < 8; i++) {
        if (arena[0x304 + i] != (u8)i) return fail("OSBlockMove does not tolerate overlap");
    }

    /* A zero-length move must not dereference its (bogus) addresses. */
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0xfffffff0u;
    cpu.gpr[4] = 0xfffffff0u;
    cpu.gpr[5] = 0u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMove") != 1) return fail("OSBlockMove empty unresolved");
    before.gpr[3] = 0xfffffff0u;
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("OSBlockMove empty changed registers");
    return 0;
}

static int test_block_set(void) {
    Cpu cpu;
    Cpu before;
    unsigned i;

    memset(arena + 0x400, 0xaa, 16);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x404u;
    cpu.gpr[4] = 0x7eu;
    cpu.gpr[5] = 4u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockSet") != 1) return fail("OSBlockSet unresolved");
    before.gpr[3] = 0x404u;
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("OSBlockSet changed unexpected registers");
    for (i = 0; i < 16; i++) {
        u8 want = (i >= 4 && i < 8) ? 0x7eu : 0xaau;
        if (arena[0x400 + i] != want) return fail("OSBlockSet filled the wrong bytes");
    }

    /* The value parameter is documented as uint8_t: only the low byte counts. */
    memset(arena + 0x410, 0x11, 4);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x410u;
    cpu.gpr[4] = 0x1234u;
    cpu.gpr[5] = 4u;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockSet") != 1) return fail("OSBlockSet truncation unresolved");
    for (i = 0; i < 4; i++) {
        if (arena[0x410 + i] != 0x34u) return fail("OSBlockSet did not truncate the fill value");
    }
    return 0;
}

static int test_memcpy(void) {
    Cpu cpu;
    Cpu before;
    unsigned i;

    for (i = 0; i < 8; i++) arena[0x500 + i] = (u8)(0x60u + i);
    memset(arena + 0x600, 0, 8);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x600u;
    cpu.gpr[4] = 0x500u;
    cpu.gpr[5] = 8u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.memcpy") != 1) return fail("memcpy unresolved");
    before.gpr[3] = 0x600u;
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("memcpy changed unexpected registers");
    for (i = 0; i < 8; i++) {
        if (arena[0x600 + i] != (u8)(0x60u + i)) return fail("memcpy copied wrong bytes");
    }
    return 0;
}

static int test_memset(void) {
    Cpu cpu;
    Cpu before;
    unsigned i;

    memset(arena + 0x700, 0x11, 8);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x702u;
    cpu.gpr[4] = 0x1abu;
    cpu.gpr[5] = 3u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.memset") != 1) return fail("memset unresolved");
    before.gpr[3] = 0x702u;
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("memset changed unexpected registers");
    for (i = 0; i < 8; i++) {
        u8 want = (i >= 2 && i < 5) ? 0xabu : 0x11u;
        if (arena[0x700 + i] != want) return fail("memset filled the wrong bytes");
    }
    return 0;
}

static int test_dc_zero_range(void) {
    Cpu cpu;
    Cpu before;
    unsigned i;

    memset(arena + 0x800, 0xff, 0x40);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x801u;
    cpu.gpr[4] = 1u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.DCZeroRange") != 1) return fail("DCZeroRange unresolved");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("DCZeroRange changed registers");
    for (i = 0; i < 0x20; i++) {
        if (arena[0x800 + i] != 0) return fail("DCZeroRange missed part of the containing block");
    }
    for (i = 0x20; i < 0x40; i++) {
        if (arena[0x800 + i] != 0xff) return fail("DCZeroRange touched the next block");
    }

    /* A zero-length range is a no-op and must not validate the address. */
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0xfffffff0u;
    cpu.gpr[4] = 0u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.DCZeroRange") != 1) return fail("DCZeroRange empty unresolved");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("DCZeroRange empty changed registers");
    return 0;
}

static int test_cache_and_barrier(void) {
    static const char *const noops[] = {
        "coreinit.DCFlushRange",
        "coreinit.DCFlushRangeNoSync",
        "coreinit.DCInvalidateRange",
        "coreinit.OSMemoryBarrier",
    };
    Cpu cpu;
    Cpu before;
    unsigned i;

    memset(arena + 0x900, 0x5a, 8);
    for (i = 0; i < sizeof(noops) / sizeof(noops[0]); i++) {
        memset(&cpu, 0x5a, sizeof cpu);
        if (strcmp(noops[i], "coreinit.OSMemoryBarrier") == 0) {
            cpu.gpr[3] = 0x5a5a5a5au;
        } else {
            cpu.gpr[3] = 0x900u;
            cpu.gpr[4] = 8u;
        }
        before = cpu;
        if (ppcx_hle_dispatch_named(&cpu, noops[i]) != 1) return fail("cache/barrier import unresolved");
        if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("cache/barrier import changed registers");
    }
    for (i = 0; i < 8; i++) {
        if (arena[0x900 + i] != 0x5a) return fail("cache maintenance changed guest data");
    }
    return 0;
}

static int test_exact_names(void) {
    Cpu cpu;
    Cpu before;

    memset(&cpu, 0x55, sizeof cpu);
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIInit") != 0) return fail("nonimplemented function reported implemented");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("unknown function changed CPU");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSGetCoreIdSuffix") != 0) return fail("non-exact match was accepted");
    if (ppcx_hle_dispatch_named(&cpu, "other.OSGetCoreId") != 0) return fail("incorrect module accepted");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMoveX") != 0) return fail("non-exact memory import accepted");
    if (ppcx_hle_dispatch_named(&cpu, "other.OSBlockMove") != 0) return fail("incorrect memory module accepted");
    if (ppcx_hle_dispatch_named(&cpu, NULL) != 0 || ppcx_hle_dispatch_named(NULL, "coreinit.OSGetCoreId") != 0) return fail("invalid args");
    return 0;
}

int main(void) {
    ppcx_memory = arena;
    if (test_identity() != 0) return 1;
    if (test_block_move() != 0) return 1;
    if (test_block_set() != 0) return 1;
    if (test_memcpy() != 0) return 1;
    if (test_memset() != 0) return 1;
    if (test_dc_zero_range() != 0) return 1;
    if (test_cache_and_barrier() != 0) return 1;
    if (test_exact_names() != 0) return 1;
    puts("hle: core identity and memory/cache models, exact matching and register preservation OK");
    return 0;
}
