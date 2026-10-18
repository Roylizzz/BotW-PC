/*
 * Minimal runtime for the statically recompiled RPX code (prototype).
 *
 * What this iteration does:
 *   - allocates one flat arena covering the whole guest address space;
 *   - resolves guest addresses to translated functions by binary search
 *     over the generated registry;
 *   - gives address-taken imports stable pseudo-addresses in a reserved
 *     region and routes both `PPCX_IMPORT_ADDR` dispatches and direct
 *     `PPCX_HLE` calls into the HLE layer;
 *   - stops with a precise diagnostic when execution reaches code that
 *     has no translation or a target that has no registered function.
 *
 * The operating system is not modelled yet: every HLE call is counted and
 * returns with the CPU untouched. `PPCX_HLE_TRACE=1` logs each call and
 * `PPCX_HLE_STRICT=1` aborts on the first one.
 *
 * This code is original to the BotW-PC project and licensed under MIT.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ppcx_abi.h"
#include "ppcx_runtime.h"

/*
 * The RPX is linked for addresses up to ~0xC1xxxxxx (the import slots sit
 * at 0xC0000000), so one arena covers the whole guest address space.
 */
#define PPCX_ARENA_BYTES 0xC2000000u

/*
 * Address-taken imports get pseudo-addresses in a region no RPX section
 * uses: above .text (which ends at 0x04347C2C in v208) and below the
 * import slots (0xC0000000).
 */
#define PPCX_HLE_TRAMPOLINE_BASE 0x50000000u
#define PPCX_HLE_TRAMPOLINE_STRIDE 8u
#define PPCX_HLE_TRAMPOLINE_RANGE (0x10000u * PPCX_HLE_TRAMPOLINE_STRIDE)

/* Initial guest stack pointer for ad-hoc entry points. */
#define PPCX_INITIAL_STACK 0x10000000u

u8 *ppcx_memory = NULL;

static unsigned g_hle_calls;
static int g_trace;
static int g_strict;
static int g_initialized;

void ppcx_runtime_init(void) {
    if (g_initialized) return;
    g_initialized = 1;
    g_trace = getenv("PPCX_HLE_TRACE") != NULL;
    g_strict = getenv("PPCX_HLE_STRICT") != NULL;
    ppcx_memory = (u8 *)calloc(1, (size_t)PPCX_ARENA_BYTES);
    if (ppcx_memory == NULL) {
        fprintf(stderr, "ppcx: could not allocate the guest arena (%u bytes)\n",
                (unsigned)PPCX_ARENA_BYTES);
        exit(2);
    }
}

static const PpcxEntry *ppcx_find(u32 addr) {
    unsigned lo = 0;
    unsigned hi = ppcx_function_count;
    while (lo < hi) {
        unsigned mid = lo + (hi - lo) / 2;
        u32 a = ppcx_functions[mid].addr;
        if (a == addr) return &ppcx_functions[mid];
        if (a < addr) lo = mid + 1;
        else hi = mid;
    }
    return NULL;
}

static void ppcx_dump_state(const Cpu *c) {
    fprintf(stderr,
            "      r1 0x%08X  r2 0x%08X  r3 0x%08X  lr 0x%08X  ctr 0x%08X\n",
            (unsigned)c->gpr[1], (unsigned)c->gpr[2], (unsigned)c->gpr[3],
            (unsigned)c->lr, (unsigned)c->ctr);
}

void ppcx_dispatch(Cpu *c, u32 target) {
    if (target >= PPCX_HLE_TRAMPOLINE_BASE &&
        target < PPCX_HLE_TRAMPOLINE_BASE + PPCX_HLE_TRAMPOLINE_RANGE) {
        ppcx_hle_call(c, (target - PPCX_HLE_TRAMPOLINE_BASE) / PPCX_HLE_TRAMPOLINE_STRIDE);
        return;
    }
    {
        const PpcxEntry *entry = ppcx_find(target);
        if (entry == NULL) {
            ppcx_call_unknown(c, target);
            return;
        }
        entry->fn(c);
    }
}

void ppcx_unimpl(Cpu *c, u32 addr) {
    fprintf(stderr, "ppcx: reached an instruction with no translation yet (0x%08X)\n",
            (unsigned)addr);
    ppcx_dump_state(c);
    exit(3);
}

void ppcx_call_unknown(Cpu *c, u32 target) {
    fprintf(stderr, "ppcx: branch or call to an address with no registered function (0x%08X)\n",
            (unsigned)target);
    ppcx_dump_state(c);
    exit(4);
}

void ppcx_hle_call(Cpu *c, u32 import_index) {
    const char *name = ppcx_import_name(import_index);
    g_hle_calls++;
    if (g_strict) {
        fprintf(stderr, "ppcx: HLE call to %s (import %u) in strict mode\n",
                name, (unsigned)import_index);
        ppcx_dump_state(c);
        exit(5);
    }
    if (g_trace) {
        fprintf(stderr, "ppcx: HLE call #%u: %s (import %u)\n",
                g_hle_calls, name, (unsigned)import_index);
    }
    /* No model implemented yet: the call returns with the CPU untouched. */
}

u32 ppcx_import_addr(u32 import_index) {
    return PPCX_HLE_TRAMPOLINE_BASE + import_index * PPCX_HLE_TRAMPOLINE_STRIDE;
}

unsigned ppcx_hle_call_count(void) {
    return g_hle_calls;
}

int ppcx_run(void) {
    Cpu cpu;
    ppcx_runtime_init();
    memset(&cpu, 0, sizeof(cpu));
    cpu.gpr[1] = PPCX_INITIAL_STACK;
    fprintf(stderr, "ppcx: entry 0x%08X, %u translated function(s)\n",
            (unsigned)ppcx_entry, ppcx_function_count);
    ppcx_dispatch(&cpu, ppcx_entry);
    fprintf(stderr, "ppcx: entry returned, r3 = 0x%08X\n", (unsigned)cpu.gpr[3]);
    fprintf(stderr, "ppcx: HLE calls: %u (no models implemented yet)\n", g_hle_calls);
    return 0;
}
