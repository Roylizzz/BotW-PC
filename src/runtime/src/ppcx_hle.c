/*
 * Small, exact-name Cafe OS HLE registry. MIT, original implementation.
 *
 * Models the core-identity calls used by this single-thread prototype (its
 * only guest context is pinned to Wii U main core 1), the guest-memory and
 * cache primitives whose contracts are purely mechanical, the proc_ui
 * lifecycle, the deterministic virtual clock/system-info services, the
 * single-module TLS index resolver, the fast-mutex calls as no-contention
 * counters, and the headless input services used by the input manager. It is
 * NOT a scheduler, a filesystem, a threading implementation, a HOME-menu
 * integration or a host input backend.
 *
 * The flat arena has no data cache: guest-visible memory is always coherent,
 * so the cache-maintenance calls are typed no-ops that still validate their
 * range against the region map. OSBlockMove keeps its documented memmove
 * semantics (overlap supported) and its 0x20-byte block granularity is
 * preserved by DCZeroRange through ppcx_dcbz.
 *
 * API signatures, return values and overlap semantics checked against
 * devkitPro/wut coreinit/core.h, memory.h, cache.h, time.h, systeminfo.h,
 * fastmutex.h and proc_ui/procui.h.
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

/* ---- virtual clock and system info -----------------------------------
 *
 * Public signatures checked against wut coreinit/time.h and systeminfo.h.
 * The model is deliberately deterministic and headless: there is no host
 * wall-clock read and no timer interrupt. The virtual machine boots at a fixed
 * epoch (2026-01-01, 9497 days after the OSTime epoch) and every successful
 * OSGetSystemTime/OSGetTime read advances one virtual 60 Hz frame, so a
 * polling loop makes progress while every run remains byte-identical.
 *
 * OSGetSystemInfo returns a pointer into the reserved HLE data page. The
 * runtime maps that page before starting the entry; the 0x20-byte record
 * reports the Wii U clock rates and the virtual boot time. OSGetTime returns
 * ticks since 2000-01-01, so OSTicksToCalendarTime can produce a coherent
 * calendar date. Negative inputs clamp to 2000-01-01.
 */
static PpcxClockState g_clock;

const PpcxClockState *ppcx_hle_clock_state(void) {
    return &g_clock;
}

void ppcx_hle_clock_reset(void) {
    memset(&g_clock, 0, sizeof g_clock);
    g_clock.system_info.bus_clock_speed = PPCX_CLOCK_BUS_HZ;
    g_clock.system_info.core_clock_speed = PPCX_CLOCK_CORE_HZ;
    g_clock.system_info.base_time = PPCX_CLOCK_EPOCH_TICKS;
}

static u64 hle_clock_advance(void) {
    g_clock.system_ticks += (u64)PPCX_CLOCK_STEP_TICKS;
    return g_clock.system_ticks;
}

static void hle_clock_return_u64(Cpu *cpu, u64 value) {
    cpu->gpr[3] = (u32)(value >> 32);
    cpu->gpr[4] = (u32)value;
}

static void hle_get_system_time(Cpu *cpu) {
    u64 now = hle_clock_advance();
    g_clock.system_time_calls++;
    g_clock.last_system_time = now;
    hle_clock_return_u64(cpu, now);
}

static void hle_get_time(Cpu *cpu) {
    u64 now = PPCX_CLOCK_EPOCH_TICKS + hle_clock_advance();
    g_clock.time_calls++;
    g_clock.last_time = now;
    hle_clock_return_u64(cpu, now);
}

static void hle_write_system_info(void) {
    u32 ea = PPCX_SYSTEM_INFO_ADDR;
    u32 off;

    hle_check_range(ea, PPCX_SYSTEM_INFO_SIZE, 1);
    ppcx_wr32(ea + 0x00u, PPCX_CLOCK_BUS_HZ);
    ppcx_wr32(ea + 0x04u, PPCX_CLOCK_CORE_HZ);
    ppcx_wr64(ea + 0x08u, PPCX_CLOCK_EPOCH_TICKS);
    for (off = 0x10u; off < PPCX_SYSTEM_INFO_SIZE; off += 4u) {
        ppcx_wr32(ea + off, 0u);
    }
}

static void hle_get_system_info(Cpu *cpu) {
    g_clock.system_info_calls++;
    g_clock.system_info.bus_clock_speed = PPCX_CLOCK_BUS_HZ;
    g_clock.system_info.core_clock_speed = PPCX_CLOCK_CORE_HZ;
    g_clock.system_info.base_time = PPCX_CLOCK_EPOCH_TICKS;
    hle_write_system_info();
    cpu->gpr[3] = PPCX_SYSTEM_INFO_ADDR;
}

static int hle_is_leap_year(u32 year) {
    return (year % 4u == 0u && year % 100u != 0u) || year % 400u == 0u;
}

static void hle_ticks_to_calendar(Cpu *cpu) {
    static const u32 month_days[12] = {
        31u, 28u, 31u, 30u, 31u, 30u, 31u, 31u, 30u, 31u, 30u, 31u
    };
    u64 raw = ((u64)cpu->gpr[3] << 32) | (u64)cpu->gpr[4];
    int negative = (int)(raw >> 63);
    u64 ticks;
    u64 seconds;
    u64 micros;
    u64 total_days;
    u64 remaining;
    u32 out_ea = cpu->gpr[5];
    u32 year = 2000u;
    u32 mon = 0u;
    u32 day_of_year;
    u32 wday;
    u32 sod;
    u32 hour;
    u32 minute;
    u32 second;
    u32 msec;
    u32 usec;
    u32 fields[10];
    u32 i;

    g_clock.calendar_calls++;
    g_clock.last_calendar_ea = out_ea;
    hle_check_range(out_ea, PPCX_CALENDAR_TIME_SIZE, 1);

    if (negative) {
        g_clock.calendar_negative++;
        ticks = 0u;
    } else {
        ticks = raw;
    }
    g_clock.last_calendar_ticks = ticks;

    seconds = ticks / (u64)PPCX_CLOCK_TIMER_HZ;
    micros = ((ticks % (u64)PPCX_CLOCK_TIMER_HZ) * 1000000ull) /
             (u64)PPCX_CLOCK_TIMER_HZ;
    total_days = seconds / 86400ull;
    sod = (u32)(seconds % 86400ull);

    remaining = total_days;
    for (;;) {
        u32 days_in_year = hle_is_leap_year(year) ? 366u : 365u;
        if (remaining < (u64)days_in_year) break;
        remaining -= (u64)days_in_year;
        year++;
    }

    day_of_year = (u32)remaining;
    for (;;) {
        u32 days_in_month = month_days[mon];
        if (mon == 1u && hle_is_leap_year(year)) days_in_month++;
        if (remaining < (u64)days_in_month || mon == 11u) break;
        remaining -= (u64)days_in_month;
        mon++;
    }

    wday = (u32)((total_days + 6ull) % 7ull); /* 2000-01-01 was Saturday */
    hour = sod / 3600u;
    minute = (sod % 3600u) / 60u;
    second = sod % 60u;
    msec = (u32)(micros / 1000ull);
    usec = (u32)(micros % 1000ull);

    fields[0] = second;
    fields[1] = minute;
    fields[2] = hour;
    fields[3] = (u32)remaining + 1u;
    fields[4] = mon;
    fields[5] = year;
    fields[6] = wday;
    fields[7] = day_of_year;
    fields[8] = msec;
    fields[9] = usec;
    for (i = 0u; i < 10u; i++) {
        ppcx_wr32(out_ea + i * 4u, fields[i]);
    }
}

/* ---- TLS --------------------------------------------------------------
 * The load image resolves the main module's TLS relocations to module 1 and
 * symbol-relative offsets. This model owns a zero-filled block inside the
 * reserved HLE data page; it is not a thread-local copy and does not model
 * .tdata. A valid TLSIndex returns block + offset, while an unknown module or
 * an offset outside the block returns NULL deterministically.
 */
static PpcxTlsState g_tls;

const PpcxTlsState *ppcx_hle_tls_state(void) {
    return &g_tls;
}

void ppcx_hle_tls_reset(void) {
    memset(&g_tls, 0, sizeof g_tls);
    if (ppcx_memory != NULL) {
        memset(ppcx_memory + (size_t)PPCX_TLS_DATA_ADDR, 0, (size_t)PPCX_TLS_DATA_SIZE);
    }
}

static void hle_tls_get_addr(Cpu *cpu) {
    u32 index_ea = cpu->gpr[3];
    u32 module;
    u32 offset;
    u32 result = 0u;

    g_tls.calls++;
    g_tls.last_index_ea = index_ea;
    hle_check_range(index_ea, 8u, 0);
    module = ppcx_rd32(index_ea);
    offset = ppcx_rd32(index_ea + 4u);
    g_tls.last_module = module;
    g_tls.last_offset = offset;

    if (module != PPCX_TLS_MODULE_ID) {
        g_tls.invalid_module++;
    } else if (offset >= PPCX_TLS_DATA_SIZE) {
        g_tls.invalid_offset++;
    } else {
        result = PPCX_TLS_DATA_ADDR + offset;
        g_tls.resolved++;
    }

    g_tls.last_result = result;
    cpu->gpr[3] = result;
}

/* ---- default heap -----------------------------------------------------
 *
 * MEMAllocFromDefaultHeap/Ex and MEMFreeToDefaultHeap are imported as data
 * function pointers, not as callable REL24 imports. The model is a single
 * deterministic bump arena: enough to let early real-code probes run through
 * GraphicsSystem allocation, but not a MEM1/MEM2 heap and not a reclaimer.
 */
static PpcxDefaultHeapState g_default_heap;

const PpcxDefaultHeapState *ppcx_hle_default_heap_state(void) {
    return &g_default_heap;
}

static u32 hle_base_heap_handle(u32 type) {
    switch (type) {
    case 0u: return PPCX_HLE_HEAP_HANDLE_MEM1_ADDR; /* MEM_BASE_HEAP_MEM1 */
    case 1u: return PPCX_HLE_HEAP_HANDLE_MEM2_ADDR; /* MEM_BASE_HEAP_MEM2 */
    case 8u: return PPCX_HLE_HEAP_HANDLE_FG_ADDR;   /* MEM_BASE_HEAP_FG */
    default: return 0u;
    }
}

static int hle_is_base_heap_handle(u32 handle) {
    return handle == PPCX_HLE_HEAP_HANDLE_MEM1_ADDR ||
           handle == PPCX_HLE_HEAP_HANDLE_MEM2_ADDR ||
           handle == PPCX_HLE_HEAP_HANDLE_FG_ADDR;
}

static void hle_write_heap_header(u32 handle) {
    /* The guest only passes these handles back to the MEM HLE, but writing a
     * plausible MEMFrmHeap header keeps diagnostics and guest reads honest.
     * The contract test runs on a raw arena without the runtime region map,
     * so it deliberately skips guest-memory writes. */
    if (!ppcx_mem_active) return;
    ppcx_wr32(handle + 0x00u, 0x46524D48u); /* MEM_FRAME_HEAP_TAG */
    ppcx_wr32(handle + 0x18u, PPCX_HLE_HEAP_DATA_START);
    ppcx_wr32(handle + 0x1Cu, PPCX_HLE_HEAP_ADDR + PPCX_HLE_HEAP_SIZE);
    ppcx_wr32(handle + 0x40u, PPCX_HLE_HEAP_DATA_START); /* head */
    ppcx_wr32(handle + 0x44u, PPCX_HLE_HEAP_DATA_START); /* tail */
    ppcx_wr32(handle + 0x48u, 0u);                       /* previousState */
}

void ppcx_hle_default_heap_reset(void) {
    memset(&g_default_heap, 0, sizeof g_default_heap);
    g_default_heap.next = PPCX_HLE_HEAP_DATA_START;
    g_default_heap.limit = PPCX_HLE_HEAP_ADDR + PPCX_HLE_HEAP_SIZE;
    hle_write_heap_header(PPCX_HLE_HEAP_HANDLE_MEM1_ADDR);
    hle_write_heap_header(PPCX_HLE_HEAP_HANDLE_MEM2_ADDR);
    hle_write_heap_header(PPCX_HLE_HEAP_HANDLE_FG_ADDR);
}

static u32 hle_default_heap_alloc(u32 size, u32 alignment) {
    PpcxDefaultHeapState *s = &g_default_heap;
    u32 aligned;
    u32 effective_align = alignment;

    s->allocations++;
    s->last_size = size;
    if (effective_align < 4u) effective_align = 4u;
    s->last_align = effective_align;

    if (size == 0u) {
        s->zero_size++;
        s->last_ptr = 0u;
        return 0u;
    }
    if ((effective_align & (effective_align - 1u)) != 0u) {
        s->failures++;
        s->last_ptr = 0u;
        return 0u;
    }
    aligned = (s->next + effective_align - 1u) & ~(effective_align - 1u);
    if (aligned < s->next || (u64)aligned + (u64)size > (u64)s->limit) {
        s->failures++;
        s->last_ptr = 0u;
        return 0u;
    }
    s->next = aligned + size;
    s->total_bytes += size;
    s->last_ptr = aligned;
    return aligned;
}

static void hle_alloc_default(Cpu *cpu) {
    cpu->gpr[3] = hle_default_heap_alloc(cpu->gpr[3], 4u);
}

static void hle_alloc_default_ex(Cpu *cpu) {
    s32 alignment = (s32)cpu->gpr[4];
    cpu->gpr[3] = hle_default_heap_alloc(cpu->gpr[3], alignment > 0 ? (u32)alignment : 0u);
}

static void hle_free_default(Cpu *cpu) {
    (void)cpu;
    g_default_heap.frees++;
}

static u32 hle_default_heap_allocatable(u32 alignment) {
    PpcxDefaultHeapState *s = &g_default_heap;
    u32 effective_align = alignment < 4u ? 4u : alignment;
    u32 aligned;

    if ((effective_align & (effective_align - 1u)) != 0u) return 0u;
    aligned = (s->next + effective_align - 1u) & ~(effective_align - 1u);
    if (aligned < s->next || aligned > s->limit) return 0u;
    return s->limit - aligned;
}

static void hle_get_base_heap(Cpu *cpu) {
    cpu->gpr[3] = hle_base_heap_handle(cpu->gpr[3]);
}

static void hle_frm_heap_allocatable(Cpu *cpu) {
    u32 handle = cpu->gpr[3];
    if (!hle_is_base_heap_handle(handle)) {
        cpu->gpr[3] = 0u;
        return;
    }
    cpu->gpr[3] = hle_default_heap_allocatable(cpu->gpr[4]);
}

static void hle_frm_heap_alloc(Cpu *cpu) {
    u32 handle = cpu->gpr[3];
    if (!hle_is_base_heap_handle(handle)) {
        g_default_heap.failures++;
        cpu->gpr[3] = 0u;
        return;
    }
    cpu->gpr[3] = hle_default_heap_alloc(cpu->gpr[4], cpu->gpr[5]);
}

/* ---- fast mutex -------------------------------------------------------
 *
 * The current runtime executes one guest context, so these models represent
 * only the uncontended case: Lock/Unlock do not suspend and TryLock succeeds.
 * Init initializes the wut-defined OSFastMutex layout so guest code that
 * inspects tag/name sees the expected values. No queue links or ownership are
 * maintained; this is not a threading implementation.
 */
static PpcxFastMutexState g_fast_mutex;

const PpcxFastMutexState *ppcx_hle_fast_mutex_state(void) {
    return &g_fast_mutex;
}

void ppcx_hle_fast_mutex_reset(void) {
    memset(&g_fast_mutex, 0, sizeof g_fast_mutex);
}

static void hle_fast_mutex_init(Cpu *cpu) {
    u32 mutex = cpu->gpr[3];
    u32 name = cpu->gpr[4];
    u32 off;

    g_fast_mutex.inits++;
    g_fast_mutex.last_mutex = mutex;
    g_fast_mutex.last_name = name;
    hle_check_range(mutex, PPCX_FAST_MUTEX_SIZE, 1);
    ppcx_wr32(mutex, PPCX_FAST_MUTEX_TAG);
    ppcx_wr32(mutex + 4u, name);
    for (off = 8u; off < PPCX_FAST_MUTEX_SIZE; off += 4u) {
        ppcx_wr32(mutex + off, 0u);
    }
}

static void hle_fast_mutex_lock(Cpu *cpu) {
    (void)cpu;
    g_fast_mutex.locks++;
}

static void hle_fast_mutex_unlock(Cpu *cpu) {
    (void)cpu;
    g_fast_mutex.unlocks++;
}

static void hle_fast_mutex_try_lock(Cpu *cpu) {
    g_fast_mutex.trylocks++;
    cpu->gpr[3] = 1u; /* uncontended: acquisition succeeds */
}

/* ---- GHS C-library data ------------------------------------------------
 * __gh_FOPEN_MAX and _iob are data imports, so they are resolved by name to
 * storage in a page that is separate from the OSSystemInfo/TLS page. The
 * values follow the decaf GHS ABI: 20 open files, 0x10-byte iobuf entries and
 * the three standard streams flagged readable/writable on channels 0..2.
 * Stream buffers and host file descriptors are deliberately not modeled.
 */
u32 ppcx_hle_data_addr(const char *qualified_name) {
    if (qualified_name == NULL) return 0u;
    if (strcmp(qualified_name, "coreinit.MEMAllocFromDefaultHeap") == 0) {
        return PPCX_HLE_DEFAULT_HEAP_ALLOC_ADDR;
    }
    if (strcmp(qualified_name, "coreinit.MEMAllocFromDefaultHeapEx") == 0) {
        return PPCX_HLE_DEFAULT_HEAP_ALLOC_EX_ADDR;
    }
    if (strcmp(qualified_name, "coreinit.MEMFreeToDefaultHeap") == 0) {
        return PPCX_HLE_DEFAULT_HEAP_FREE_ADDR;
    }
    if (strcmp(qualified_name, "coreinit.__gh_FOPEN_MAX") == 0) {
        return PPCX_GH_FOPEN_MAX_ADDR;
    }
    if (strcmp(qualified_name, "coreinit._iob") == 0) return PPCX_GHS_IOB_ADDR;
    return 0u;
}

int ppcx_hle_data_is_fnptr_addr(u32 addr) {
    return addr == PPCX_HLE_DEFAULT_HEAP_ALLOC_ADDR ||
           addr == PPCX_HLE_DEFAULT_HEAP_ALLOC_EX_ADDR ||
           addr == PPCX_HLE_DEFAULT_HEAP_FREE_ADDR;
}

void ppcx_hle_ghs_reset(void) {
    if (ppcx_memory == NULL) return;
    memset(ppcx_memory + (size_t)PPCX_GHS_DATA_ADDR, 0, (size_t)PPCX_GHS_DATA_SIZE);
    ppcx_wr16(PPCX_GH_FOPEN_MAX_ADDR, (u16)PPCX_GH_FOPEN_MAX);
    /* ghs_iobuf.info: bit 1 writable, bit 2 readable, channel in bits
     * 18..31. These are the gh_iob_init values for the three standard
     * streams; the remaining 17 entries stay zeroed. */
    ppcx_wr32(PPCX_GHS_IOB_ADDR + 0u * PPCX_GHS_IOBUF_SIZE + PPCX_GHS_IOB_INFO_OFFSET, 0x00000004u);
    ppcx_wr32(PPCX_GHS_IOB_ADDR + 1u * PPCX_GHS_IOBUF_SIZE + PPCX_GHS_IOB_INFO_OFFSET, 0x00040002u);
    ppcx_wr32(PPCX_GHS_IOB_ADDR + 2u * PPCX_GHS_IOBUF_SIZE + PPCX_GHS_IOB_INFO_OFFSET, 0x00080002u);
}

/* ---- input ------------------------------------------------------------
 *
 * Public contracts checked against wut padscore/kpad.h, padscore/wpad.h,
 * vpad/input.h and vpadbase/base.h. This is a deterministic placeholder:
 * one neutral virtual GamePad is present on VPAD channel 0. A read returns one
 * zero-filled status record, which is a valid "no buttons, centered sticks,
 * no touch" sample. No KPAD/WPAD controller is present, so KPAD reads produce
 * no samples and WPAD probes report no controller. No host input is read and
 * no callback fires.
 */
enum {
    PPCX_KPAD_ERROR_NO_SAMPLES = -1,
    PPCX_KPAD_ERROR_INVALID_CONTROLLER = -2,
    PPCX_KPAD_ERROR_UNINITIALIZED = -5,
    PPCX_VPAD_READ_SUCCESS = 0,
    PPCX_VPAD_READ_NO_SAMPLES = -1,
    PPCX_VPAD_READ_INVALID_CONTROLLER = -2,
    PPCX_WPAD_ERROR_NO_CONTROLLER = -1
};

static PpcxInputState g_input;

const PpcxInputState *ppcx_hle_input_state(void) {
    return &g_input;
}

void ppcx_hle_input_reset(void) {
    memset(&g_input, 0, sizeof g_input);
}

static void hle_kpad_get_mpls_work_size(Cpu *cpu) {
    g_input.kpad_mpls_size_calls++;
    cpu->gpr[3] = PPCX_INPUT_MPLS_WORK_SIZE;
}

static void hle_kpad_init_ex(Cpu *cpu) {
    u32 buffer = cpu->gpr[3];
    u32 count = cpu->gpr[4];
    g_input.kpad_init_calls++;
    if (count != 0u && buffer == 0u) {
        g_input.kpad_invalid_init++;
        g_input.kpad_initialized = 0u;
        return;
    }
    g_input.kpad_initialized = 1u;
    g_input.kpad_init_buffer = buffer;
    g_input.kpad_init_count = count;
}

static void hle_kpad_set_mpls_workarea(Cpu *cpu) {
    g_input.kpad_mpls_workarea_calls++;
    g_input.kpad_mpls_workarea = cpu->gpr[3];
}

static void hle_kpad_read_ex(Cpu *cpu) {
    u32 chan = cpu->gpr[3];
    u32 count = cpu->gpr[5];
    u32 error_ea = cpu->gpr[6];
    u32 error;

    g_input.kpad_read_calls++;
    g_input.kpad_last_chan = chan;
    g_input.kpad_last_count = count;

    if (!g_input.kpad_initialized) {
        error = (u32)PPCX_KPAD_ERROR_UNINITIALIZED;
        g_input.kpad_invalid_reads++;
    } else if (chan >= PPCX_INPUT_KPAD_CHANNELS) {
        error = (u32)PPCX_KPAD_ERROR_INVALID_CONTROLLER;
        g_input.kpad_invalid_reads++;
    } else {
        /* The model has no Wii Remote/Pro Controller: even a non-zero count
         * produces no sample and the guest buffer is left untouched. */
        error = (u32)PPCX_KPAD_ERROR_NO_SAMPLES;
        g_input.kpad_no_samples++;
    }

    if (error_ea != 0u) ppcx_wr32(error_ea, error);
    g_input.kpad_last_error = error;
    cpu->gpr[3] = 0u;
}

static void hle_vpad_read(Cpu *cpu) {
    u32 chan = cpu->gpr[3];
    u32 buffers = cpu->gpr[4];
    u32 count = cpu->gpr[5];
    u32 error_ea = cpu->gpr[6];
    u32 error = (u32)PPCX_VPAD_READ_SUCCESS;
    u32 samples = 0u;

    g_input.vpad_read_calls++;
    g_input.vpad_last_chan = chan;
    g_input.vpad_last_count = count;

    if (chan >= PPCX_INPUT_VPAD_CHANNELS) {
        error = (u32)PPCX_VPAD_READ_INVALID_CONTROLLER;
        g_input.vpad_invalid_reads++;
    } else if (count == 0u) {
        error = (u32)PPCX_VPAD_READ_NO_SAMPLES;
        g_input.vpad_no_samples++;
    } else if (buffers == 0u) {
        error = (u32)PPCX_VPAD_READ_NO_SAMPLES;
        g_input.vpad_invalid_reads++;
    } else if (chan == 0u) {
        hle_check_range(buffers, PPCX_VPAD_STATUS_SIZE, 1);
        memset(ppcx_memory + (size_t)buffers, 0, PPCX_VPAD_STATUS_SIZE);
        samples = 1u;
        g_input.vpad_samples_returned++;
    } else {
        /* Valid GamePad channel, but the model has no second controller. */
        error = (u32)PPCX_VPAD_READ_NO_SAMPLES;
        g_input.vpad_no_samples++;
    }

    if (error_ea != 0u) ppcx_wr32(error_ea, error);
    g_input.vpad_last_error = error;
    cpu->gpr[3] = samples;
}

static void hle_vpad_get_tp_calibrated_point(Cpu *cpu) {
    u32 chan = cpu->gpr[3];
    u32 out_ea = cpu->gpr[4];
    u32 in_ea = cpu->gpr[5];

    if (chan >= PPCX_INPUT_VPAD_CHANNELS || out_ea == 0u || in_ea == 0u) {
        g_input.vpad_touch_invalid++;
        return;
    }
    hle_check_range(in_ea, PPCX_VPAD_TOUCH_SIZE, 0);
    hle_check_range(out_ea, PPCX_VPAD_TOUCH_SIZE, 1);
    {
        /* The identity calibration must tolerate aliasing; use a temporary
         * because the local TCC memmove was measured not to. */
        u8 tmp[PPCX_VPAD_TOUCH_SIZE];
        memcpy(tmp, ppcx_memory + (size_t)in_ea, PPCX_VPAD_TOUCH_SIZE);
        memcpy(ppcx_memory + (size_t)out_ea, tmp, PPCX_VPAD_TOUCH_SIZE);
    }
    g_input.vpad_touch_calls++;
}

static void hle_vpad_set_sampling_callback(Cpu *cpu) {
    u32 chan = cpu->gpr[3];
    u32 callback = cpu->gpr[4];
    u32 previous = 0u;

    g_input.vpad_sampling_callback_calls++;
    g_input.last_callback = callback;
    if (chan < PPCX_INPUT_VPAD_CHANNELS) {
        previous = g_input.vpad_sampling_callbacks[chan];
        g_input.vpad_sampling_callbacks[chan] = callback;
    } else {
        g_input.vpad_sampling_callback_invalid++;
    }
    cpu->gpr[3] = previous;
}

static void hle_vpad_control_motor(Cpu *cpu) {
    u32 chan = cpu->gpr[3];
    u32 pattern = cpu->gpr[4];
    u32 length = cpu->gpr[5] & 0xffu;

    if (chan >= PPCX_INPUT_VPAD_CHANNELS || (length != 0u && pattern == 0u)) {
        g_input.vpad_motor_invalid++;
        cpu->gpr[3] = (u32)-1;
        return;
    }
    if (length != 0u) hle_check_range(pattern, length, 0);
    /* Accepted and discarded: the headless model has no rumble backend. */
    g_input.vpad_motor_calls++;
    cpu->gpr[3] = 0u;
}

static void hle_vpad_stop_motor(Cpu *cpu) {
    (void)cpu;
    g_input.vpad_stop_motor_calls++;
}

static void hle_vpad_gyro(Cpu *cpu) {
    g_input.vpad_gyro_calls++;
    g_input.last_gyro_chan = cpu->gpr[3];
}

static void hle_vpad_gyro_mode(Cpu *cpu) {
    g_input.vpad_gyro_calls++;
    g_input.last_gyro_chan = cpu->gpr[3];
    g_input.last_gyro_mode = cpu->gpr[4];
}

static void hle_wpad_probe(Cpu *cpu) {
    u32 chan = cpu->gpr[3];
    u32 out_ea = cpu->gpr[4];

    g_input.wpad_probe_calls++;
    g_input.last_probe_chan = chan;
    if (out_ea != 0u) {
        hle_check_range(out_ea, 4u, 1);
        ppcx_wr32(out_ea, 0u); /* WPAD_EXT_CORE: no extension known */
        g_input.last_probe_extension = 0u;
    }
    cpu->gpr[3] = (u32)PPCX_WPAD_ERROR_NO_CONTROLLER;
}

static void hle_wpad_start_sync(Cpu *cpu) {
    g_input.wpad_sync_calls++;
    cpu->gpr[3] = 0u; /* FALSE: no Bluetooth sync backend */
}

static void hle_wpad_enable_urcc(Cpu *cpu) {
    g_input.wpad_urcc_calls++;
    g_input.last_urcc_enable = cpu->gpr[3];
}

static void hle_vpadbase_headphone_status(Cpu *cpu) {
    g_input.headphone_calls++;
    cpu->gpr[3] = 0u; /* no headphones connected */
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
    { "coreinit.MEMAllocFromDefaultHeap", hle_alloc_default },
    { "coreinit.MEMAllocFromDefaultHeapEx", hle_alloc_default_ex },
    { "coreinit.MEMFreeToDefaultHeap", hle_free_default },
    { "coreinit.MEMGetBaseHeapHandle", hle_get_base_heap },
    { "coreinit.MEMGetAllocatableSizeForFrmHeapEx", hle_frm_heap_allocatable },
    { "coreinit.MEMAllocFromFrmHeapEx", hle_frm_heap_alloc },
    { "coreinit.OSGetSystemTime", hle_get_system_time },
    { "coreinit.OSGetTime", hle_get_time },
    { "coreinit.OSGetSystemInfo", hle_get_system_info },
    { "coreinit.OSTicksToCalendarTime", hle_ticks_to_calendar },
    { "coreinit.__tls_get_addr", hle_tls_get_addr },
    { "coreinit.OSFastMutex_Init", hle_fast_mutex_init },
    { "coreinit.OSFastMutex_Lock", hle_fast_mutex_lock },
    { "coreinit.OSFastMutex_Unlock", hle_fast_mutex_unlock },
    { "coreinit.OSFastMutex_TryLock", hle_fast_mutex_try_lock },
    { "proc_ui.ProcUIInit", hle_procui_init },
    { "proc_ui.ProcUIProcessMessages", hle_procui_process_messages },
    { "proc_ui.ProcUIDrawDoneRelease", hle_procui_draw_done_release },
    { "proc_ui.ProcUIRegisterCallback", hle_procui_register_callback },
    { "proc_ui.ProcUIShutdown", hle_procui_shutdown },
    { "padscore.KPADGetMplsWorkSize", hle_kpad_get_mpls_work_size },
    { "padscore.KPADInitEx", hle_kpad_init_ex },
    { "padscore.KPADSetMplsWorkarea", hle_kpad_set_mpls_workarea },
    { "padscore.KPADReadEx", hle_kpad_read_ex },
    { "padscore.WPADEnableURCC", hle_wpad_enable_urcc },
    { "padscore.WPADProbe", hle_wpad_probe },
    { "padscore.WPADStartSyncDevice", hle_wpad_start_sync },
    { "vpad.VPADControlMotor", hle_vpad_control_motor },
    { "vpad.VPADDisableGyroDirRevise", hle_vpad_gyro },
    { "vpad.VPADEnableGyroAccRevise", hle_vpad_gyro },
    { "vpad.VPADGetTPCalibratedPoint", hle_vpad_get_tp_calibrated_point },
    { "vpad.VPADRead", hle_vpad_read },
    { "vpad.VPADSetGyroAccReviseParam", hle_vpad_gyro },
    { "vpad.VPADSetGyroDirection", hle_vpad_gyro_mode },
    { "vpad.VPADSetGyroZeroDriftMode", hle_vpad_gyro_mode },
    { "vpad.VPADSetSamplingCallback", hle_vpad_set_sampling_callback },
    { "vpad.VPADStopMotor", hle_vpad_stop_motor },
    { "vpadbase.VPADBASEGetHeadphoneStatus", hle_vpadbase_headphone_status },
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
