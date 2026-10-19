/*
 * Checked guest-memory model: the region map behind the accessors in
 * ppcx_abi.h. See ppcx_mem.h for the contract and src/runtime/README.md
 * for how the runtime installs it.
 *
 * This C code is original to the BotW-PC project and licensed under MIT.
 */

#include "ppcx_mem.h"

#include <stdio.h>
#include <stdlib.h>

int ppcx_mem_active = 0;

typedef struct PpcxMemRegion {
    u32 start;
    u32 size;
    const char *tag;
} PpcxMemRegion;

static PpcxMemRegion g_regions[PPCX_MEM_MAX_REGIONS];
static unsigned g_region_count;
static PpcxMemFaultHook g_fault_hook;

/* 64-bit sums: a 32-bit wrap must not turn a fault into a silent success. */
static int ppcx_mem_contains(const PpcxMemRegion *r, u32 ea, unsigned size) {
    const u64 lo = (u64)ea;
    const u64 hi = (u64)ea + (u64)size;
    const u64 rlo = (u64)r->start;
    const u64 rhi = (u64)r->start + (u64)r->size;
    return lo >= rlo && hi <= rhi;
}

void ppcx_mem_reset(u32 stack_top, u32 stack_size) {
    g_region_count = 0u;
    ppcx_mem_active = 1;
    if (stack_size != 0u && (u64)stack_size <= (u64)stack_top) {
        (void)ppcx_mem_add(stack_top - stack_size, stack_size, "stack");
    }
}

int ppcx_mem_add(u32 start, u32 size, const char *tag) {
    const u64 end = (u64)start + (u64)size;
    unsigned i;
    unsigned at;

    if (size == 0u || end > (u64)PPCX_ARENA_BYTES) {
        return -3;
    }
    for (i = 0; i < g_region_count; i++) {
        const PpcxMemRegion *r = &g_regions[i];
        const u64 rend = (u64)r->start + (u64)r->size;
        if (start == r->start && size == r->size) {
            return 0; /* exact duplicate: idempotent re-registration */
        }
        if ((u64)start < rend && (u64)r->start < end) {
            return -1; /* partial overlap */
        }
    }
    if (g_region_count >= PPCX_MEM_MAX_REGIONS) {
        return -2;
    }
    at = g_region_count;
    while (at > 0u && g_regions[at - 1u].start > start) {
        at--;
    }
    for (i = g_region_count; i > at; i--) {
        g_regions[i] = g_regions[i - 1u];
    }
    g_regions[at].start = start;
    g_regions[at].size = size;
    g_regions[at].tag = tag;
    g_region_count++;
    return 0;
}

void ppcx_mem_set_fault_hook(PpcxMemFaultHook hook) {
    g_fault_hook = hook;
}

unsigned ppcx_mem_region_count(void) {
    return g_region_count;
}

int ppcx_mem_region_at(unsigned index, u32 *start, u32 *size, const char **tag) {
    if (index >= g_region_count) {
        return 0;
    }
    if (start != NULL) *start = g_regions[index].start;
    if (size != NULL) *size = g_regions[index].size;
    if (tag != NULL) *tag = g_regions[index].tag;
    return 1;
}

void ppcx_mem_check(u32 ea, unsigned size, unsigned write) {
    unsigned i;

    if (size == 0u) {
        return;
    }
    for (i = 0; i < g_region_count; i++) {
        if (ppcx_mem_contains(&g_regions[i], ea, size)) {
            return;
        }
    }
    fprintf(stderr,
            "ppcx: guest memory fault: %s of %u byte(s) at 0x%08X is not inside any mapped region\n",
            write ? "write" : "read", size, (unsigned)ea);
    if (g_fault_hook != NULL) {
        g_fault_hook(ea, size, write);
    }
    exit(9);
}
