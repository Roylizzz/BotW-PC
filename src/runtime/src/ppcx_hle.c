/*
 * Small, exact-name Cafe OS HLE registry. MIT, original implementation.
 *
 * Models the core-identity calls used by this single-thread prototype (its
 * only guest context is pinned to Wii U main core 1), the guest-memory and
 * cache primitives whose contracts are purely mechanical, and the proc_ui
 * lifecycle. It is NOT a scheduler, a filesystem, a threading implementation
 * or a HOME-menu integration.
 *
 * The flat arena has no data cache: guest-visible memory is always coherent,
 * so the cache-maintenance calls are typed no-ops that still validate their
 * range against the region map. OSBlockMove keeps its documented memmove
 * semantics (overlap supported) and its 0x20-byte block granularity is
 * preserved by DCZeroRange through ppcx_dcbz.
 *
 * API signatures, return values and overlap semantics checked against
 * devkitPro/wut coreinit/core.h, memory.h, cache.h and proc_ui/procui.h.
 */
#include "ppcx_hle.h"

#include <string.h>

typedef void (*PpcxHleHandler)(Cpu *);

typedef struct PpcxHleEntry {
    const char *name;
    PpcxHleHandler handler;
} PpcxHleEntry;

static void hle_core_count(Cpu *cpu) { cpu->gpr[3] = 3u; }
static void hle_core_id(Cpu *cpu) { cpu->gpr[3] = 1u; }
static void hle_main_core_id(Cpu *cpu) { cpu->gpr[3] = 1u; }
static void hle_is_main_core(Cpu *cpu) { cpu->gpr[3] = 1u; }

/* Check a whole guest range before touching it, so a rejected operation has
 * no partial effects. Zero-length ranges are legal and never dereferenced. */
static void hle_check_range(u32 ea, u32 size, unsigned write) {
    if (size != 0 && ppcx_mem_active) ppcx_mem_check(ea, size, write);
}

/* OSBlockMove documents memmove semantics. TCC's memmove was measured to
 * copy forward and corrupt overlapping ranges, so the overlap guarantee is
 * implemented here explicitly instead of delegating to the host libc. */
static void hle_copy(u32 dst, u32 src, u32 size) {
    u8 *d = ppcx_memory + (size_t)dst;
    const u8 *s = ppcx_memory + (size_t)src;
    size_t i;
    if (size == 0 || d == s) return;
    if (d < s || d >= s + (size_t)size) {
        memcpy(d, s, (size_t)size);
    } else {
        for (i = (size_t)size; i != 0; i--) d[i - 1] = s[i - 1];
    }
}

static void hle_block_move(Cpu *cpu) {
    u32 dst = cpu->gpr[3];
    u32 src = cpu->gpr[4];
    u32 size = cpu->gpr[5];
    /* r6 is the cache-flush hint; the flat model has no cache to flush. */
    hle_check_range(dst, size, 1);
    hle_check_range(src, size, 0);
    hle_copy(dst, src, size);
    cpu->gpr[3] = dst;
}

static void hle_block_set(Cpu *cpu) {
    u32 dst = cpu->gpr[3];
    int value = (int)(cpu->gpr[4] & 0xffu);
    u32 size = cpu->gpr[5];
    hle_check_range(dst, size, 1);
    if (size != 0) memset(ppcx_memory + (size_t)dst, value, (size_t)size);
    cpu->gpr[3] = dst;
}

static void hle_memcpy(Cpu *cpu) {
    u32 dst = cpu->gpr[3];
    u32 src = cpu->gpr[4];
    u32 size = cpu->gpr[5];
    hle_check_range(dst, size, 1);
    hle_check_range(src, size, 0);
    /* Overlapping memcpy is undefined in C; reuse the safe copy anyway. */
    hle_copy(dst, src, size);
    cpu->gpr[3] = dst;
}

static void hle_memset(Cpu *cpu) {
    u32 dst = cpu->gpr[3];
    int value = (int)(cpu->gpr[4] & 0xffu);
    u32 size = cpu->gpr[5];
    hle_check_range(dst, size, 1);
    if (size != 0) memset(ppcx_memory + (size_t)dst, value, (size_t)size);
    cpu->gpr[3] = dst;
}

/* The documented implementation zeroes whole 0x20-byte data-cache blocks for
 * the range, so an unaligned address also clears the block that contains it.
 * ppcx_dcbz applies exactly that operation and its write check. */
static void hle_dc_zero_range(Cpu *cpu) {
    u32 addr = cpu->gpr[3];
    u32 size = cpu->gpr[4];
    u64 off;
    for (off = 0; off < (u64)size; off += 32u) ppcx_dcbz(addr + (u32)off);
}

static void hle_dc_flush_range(Cpu *cpu) {
    hle_check_range(cpu->gpr[3], cpu->gpr[4], 0);
    PPCX_FENCE_SYNC();
}

static void hle_dc_flush_range_nosync(Cpu *cpu) {
    hle_check_range(cpu->gpr[3], cpu->gpr[4], 0);
}

static void hle_dc_invalidate_range(Cpu *cpu) {
    hle_check_range(cpu->gpr[3], cpu->gpr[4], 0);
}

static void hle_memory_barrier(Cpu *cpu) {
    (void)cpu;
    PPCX_FENCE_SYNC();
}

/* ---- proc_ui lifecycle ------------------------------------------------
 *
 * The public contract (wut proc_ui/procui.h): ProcUIInit installs a non-NULL
 * save callback, ProcUIProcessMessages returns the current ProcUIStatus,
 * ProcUIDrawDoneRelease acknowledges a RELEASE_FOREGROUND request, callbacks
 * are registered per event type, and ProcUIShutdown ends the lifecycle.
 *
 * Headless model: there is no HOME menu and no OS message pump, so the
 * status never leaves IN_FOREGROUND while initialized. Callbacks are stored
 * for inspection but never executed; ProcessMessages is therefore a
 * deterministic status report rather than a scheduler. The documented
 * block=false case returns an undefined value in the real API; this model
 * still reports the status, and records the flag so a test can prove it.
 */
enum {
    PPCX_PROCUI_STATUS_IN_FOREGROUND = 0,
    PPCX_PROCUI_STATUS_IN_BACKGROUND = 1,
    PPCX_PROCUI_STATUS_RELEASE_FOREGROUND = 2,
    PPCX_PROCUI_STATUS_EXITING = 3
};

static PpcxProcUiState g_procui;

const PpcxProcUiState *ppcx_hle_procui_state(void) {
    return &g_procui;
}

void ppcx_hle_procui_reset(void) {
    memset(&g_procui, 0, sizeof g_procui);
    g_procui.status = PPCX_PROCUI_STATUS_EXITING; /* not initialized */
}

static void hle_procui_init(Cpu *cpu) {
    u32 save_callback = cpu->gpr[3];
    if (save_callback == 0u) {
        /* Documented precondition: the save callback cannot be NULL. */
        g_procui.invalid_init++;
        g_procui.initialized = 0u;
        g_procui.status = PPCX_PROCUI_STATUS_EXITING;
        return;
    }
    g_procui.init_calls++;
    g_procui.initialized = 1u;
    g_procui.shutdown = 0u;
    g_procui.status = PPCX_PROCUI_STATUS_IN_FOREGROUND;
    g_procui.save_callback = save_callback;
    /* A re-initialized lifecycle starts without stale registrations. */
    g_procui.callback_count = 0u;
}

static void hle_procui_process_messages(Cpu *cpu) {
    g_procui.process_messages_calls++;
    g_procui.last_block = cpu->gpr[3];
    g_procui.status = g_procui.initialized
                          ? PPCX_PROCUI_STATUS_IN_FOREGROUND
                          : PPCX_PROCUI_STATUS_EXITING;
    cpu->gpr[3] = g_procui.status;
}

static void hle_procui_draw_done_release(Cpu *cpu) {
    (void)cpu;
    g_procui.draw_done_releases++;
}

static void hle_procui_register_callback(Cpu *cpu) {
    u32 type = cpu->gpr[3];
    u32 fn = cpu->gpr[4];
    u32 param = cpu->gpr[5];
    u32 priority = cpu->gpr[6];
    if (fn == 0u) {
        g_procui.callbacks_rejected++;
        return;
    }
    g_procui.callbacks_registered++;
    if (g_procui.callback_count >= PPCX_PROCUI_MAX_CALLBACKS) {
        g_procui.callbacks_dropped++;
        return;
    }
    g_procui.callbacks[g_procui.callback_count].type = type;
    g_procui.callbacks[g_procui.callback_count].fn = fn;
    g_procui.callbacks[g_procui.callback_count].param = param;
    g_procui.callbacks[g_procui.callback_count].priority = priority;
    g_procui.callback_count++;
}

static void hle_procui_shutdown(Cpu *cpu) {
    (void)cpu;
    g_procui.shutdown_calls++;
    g_procui.initialized = 0u;
    g_procui.shutdown = 1u;
    g_procui.status = PPCX_PROCUI_STATUS_EXITING;
}

static const PpcxHleEntry hle_registry[] = {
    { "coreinit.OSGetCoreCount", hle_core_count },
    { "coreinit.OSGetCoreId", hle_core_id },
    { "coreinit.OSGetMainCoreId", hle_main_core_id },
    { "coreinit.OSIsMainCore", hle_is_main_core },
    { "coreinit.OSBlockMove", hle_block_move },
    { "coreinit.OSBlockSet", hle_block_set },
    { "coreinit.memcpy", hle_memcpy },
    { "coreinit.memset", hle_memset },
    { "coreinit.DCZeroRange", hle_dc_zero_range },
    { "coreinit.DCFlushRange", hle_dc_flush_range },
    { "coreinit.DCFlushRangeNoSync", hle_dc_flush_range_nosync },
    { "coreinit.DCInvalidateRange", hle_dc_invalidate_range },
    { "coreinit.OSMemoryBarrier", hle_memory_barrier },
    { "proc_ui.ProcUIInit", hle_procui_init },
    { "proc_ui.ProcUIProcessMessages", hle_procui_process_messages },
    { "proc_ui.ProcUIDrawDoneRelease", hle_procui_draw_done_release },
    { "proc_ui.ProcUIRegisterCallback", hle_procui_register_callback },
    { "proc_ui.ProcUIShutdown", hle_procui_shutdown },
};

int ppcx_hle_dispatch_named(Cpu *cpu, const char *qualified_name) {
    unsigned i;
    if (cpu == NULL || qualified_name == NULL) return 0;
    for (i = 0; i < sizeof(hle_registry) / sizeof(hle_registry[0]); i++) {
        if (strcmp(qualified_name, hle_registry[i].name) == 0) {
            hle_registry[i].handler(cpu);
            return 1;
        }
    }
    return 0;
}
