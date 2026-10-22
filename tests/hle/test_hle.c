/* Source-owned synthetic test for explicit Cafe OS HLE dispatch (MIT).
 *
 * The contract test runs on a raw host arena: ppcx_mem_active stays 0 and
 * ppcx_mem_check is a stub here. The compiled memory harness (tests/mem)
 * exercises the same models with the real region map and expects the
 * read-only/unmapped faults to stop the process. */
#include "ppcx_hle.h"
#include <stdio.h>
#include <string.h>

static u8 arena[0x00100000];
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

static int test_procui_lifecycle(void) {
    Cpu cpu;
    Cpu before;
    const PpcxProcUiState *s;
    unsigned i;

    ppcx_hle_procui_reset();
    s = ppcx_hle_procui_state();
    if (s->initialized != 0u || s->status != 3u) return fail("proc_ui reset state");

    /* ProcUIInit is void and documents a non-NULL save callback. */
    memset(&cpu, 0, sizeof cpu);
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIInit") != 1) return fail("ProcUIInit unresolved");
    s = ppcx_hle_procui_state();
    if (s->initialized != 0u || s->invalid_init != 1u || s->status != 3u) return fail("ProcUIInit accepted NULL");

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x12345678u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIInit") != 1) return fail("ProcUIInit unresolved");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("ProcUIInit changed registers");
    s = ppcx_hle_procui_state();
    if (s->initialized != 1u || s->shutdown != 0u || s->status != 0u) return fail("ProcUIInit state");
    if (s->save_callback != 0x12345678u || s->init_calls != 1u) return fail("ProcUIInit arguments");

    /* RegisterCallback is void: r3-r6 are inputs and stay untouched. */
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 5u;
    cpu.gpr[4] = 0x00010048u;
    cpu.gpr[5] = 0u;
    cpu.gpr[6] = 1u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIRegisterCallback") != 1) return fail("ProcUIRegisterCallback unresolved");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("ProcUIRegisterCallback changed registers");
    s = ppcx_hle_procui_state();
    if (s->callback_count != 1u || s->callbacks_registered != 1u) return fail("ProcUIRegisterCallback count");
    if (s->callbacks[0].type != 5u || s->callbacks[0].fn != 0x00010048u) return fail("ProcUIRegisterCallback type/fn");
    if (s->callbacks[0].param != 0u || s->callbacks[0].priority != 1u) return fail("ProcUIRegisterCallback param/priority");

    /* A NULL callback is rejected, not stored. */
    memset(&cpu, 0, sizeof cpu);
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIRegisterCallback") != 1) return fail("ProcUIRegisterCallback NULL unresolved");
    s = ppcx_hle_procui_state();
    if (s->callback_count != 1u || s->callbacks_rejected != 1u) return fail("ProcUIRegisterCallback accepted NULL");

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 1u;
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIProcessMessages") != 1) return fail("ProcUIProcessMessages unresolved");
    if (cpu.gpr[3] != 0u) return fail("ProcUIProcessMessages foreground status");
    before.gpr[3] = 0u;
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("ProcUIProcessMessages changed registers");
    s = ppcx_hle_procui_state();
    if (s->process_messages_calls != 1u || s->last_block != 1u || s->status != 0u) return fail("ProcUIProcessMessages state");

    memset(&cpu, 0x5a, sizeof cpu);
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIDrawDoneRelease") != 1) return fail("ProcUIDrawDoneRelease unresolved");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("ProcUIDrawDoneRelease changed registers");
    s = ppcx_hle_procui_state();
    if (s->draw_done_releases != 1u) return fail("ProcUIDrawDoneRelease count");

    memset(&cpu, 0x5a, sizeof cpu);
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIShutdown") != 1) return fail("ProcUIShutdown unresolved");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("ProcUIShutdown changed registers");
    s = ppcx_hle_procui_state();
    if (s->shutdown_calls != 1u || s->initialized != 0u || s->shutdown != 1u || s->status != 3u) {
        return fail("ProcUIShutdown state");
    }

    /* After shutdown ProcessMessages must report EXITING. */
    memset(&cpu, 0, sizeof cpu);
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIProcessMessages") != 1) return fail("post-shutdown ProcessMessages unresolved");
    if (cpu.gpr[3] != 3u) return fail("post-shutdown ProcessMessages status");
    s = ppcx_hle_procui_state();
    if (s->process_messages_calls != 2u || s->last_block != 0u) return fail("post-shutdown ProcessMessages state");

    /* Re-init clears the lifecycle and the stale callback table. */
    memset(&cpu, 0, sizeof cpu);
    cpu.gpr[3] = 0x55u;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIInit") != 1) return fail("ProcUIInit re-init unresolved");
    s = ppcx_hle_procui_state();
    if (s->initialized != 1u || s->shutdown != 0u || s->status != 0u) return fail("ProcUIInit re-init state");
    if (s->callback_count != 0u || s->callbacks_registered != 1u || s->save_callback != 0x55u) {
        return fail("ProcUIInit re-init did not clear callbacks");
    }

    /* The table is bounded: one more registration than slots is dropped. */
    for (i = 0; i < PPCX_PROCUI_MAX_CALLBACKS + 1u; i++) {
        memset(&cpu, 0, sizeof cpu);
        cpu.gpr[3] = i;
        cpu.gpr[4] = 0x1000u + i;
        cpu.gpr[5] = i;
        cpu.gpr[6] = 9u;
        if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIRegisterCallback") != 1) return fail("bounded registration unresolved");
    }
    s = ppcx_hle_procui_state();
    if (s->callback_count != PPCX_PROCUI_MAX_CALLBACKS) return fail("callback table did not fill");
    if (s->callbacks_dropped != 1u) return fail("callback overflow was not counted");
    if (s->callbacks_registered != PPCX_PROCUI_MAX_CALLBACKS + 2u) return fail("callback registration total");
    if (s->callbacks[0].type != 0u || s->callbacks[0].fn != 0x1000u) return fail("callback table did not start clean");
    if (s->callbacks[PPCX_PROCUI_MAX_CALLBACKS - 1u].type != PPCX_PROCUI_MAX_CALLBACKS - 1u) {
        return fail("callback table stored the wrong slot order");
    }
    return 0;
}

static int check_dispatch_r3(const char *name, Cpu *cpu, u32 expected) {
    Cpu before = *cpu;
    if (ppcx_hle_dispatch_named(cpu, name) != 1) return fail("HLE import unresolved");
    if (cpu->gpr[3] != expected) {
        fprintf(stderr, "hle: %s returned 0x%08x, expected 0x%08x\n", name, cpu->gpr[3], expected);
        return 1;
    }
    before.gpr[3] = expected;
    if (memcmp(cpu, &before, sizeof *cpu) != 0) return fail("HLE import changed unexpected registers");
    return 0;
}

static int check_dispatch_u64(const char *name, Cpu *cpu, u64 expected) {
    Cpu before = *cpu;
    u32 hi = (u32)(expected >> 32);
    u32 lo = (u32)expected;
    if (ppcx_hle_dispatch_named(cpu, name) != 1) return fail("64-bit HLE import unresolved");
    if (cpu->gpr[3] != hi || cpu->gpr[4] != lo) {
        fprintf(stderr, "hle: %s returned 0x%08x%08x, expected 0x%08x%08x\n", name,
                (unsigned)cpu->gpr[3], (unsigned)cpu->gpr[4], (unsigned)hi, (unsigned)lo);
        return 1;
    }
    before.gpr[3] = hi;
    before.gpr[4] = lo;
    if (memcmp(cpu, &before, sizeof *cpu) != 0) return fail("64-bit HLE import changed unexpected registers");
    return 0;
}

static int check_dispatch_void(const char *name, Cpu *cpu) {
    Cpu before = *cpu;
    if (ppcx_hle_dispatch_named(cpu, name) != 1) return fail("void HLE import unresolved");
    if (memcmp(cpu, &before, sizeof *cpu) != 0) return fail("void HLE import changed registers");
    return 0;
}

static int check_calendar_fields(u32 ea, u32 sec, u32 min, u32 hour, u32 mday,
                                 u32 mon, u32 year, u32 wday, u32 yday,
                                 u32 msec, u32 usec, const char *what) {
    static const char *const names[10] = {
        "tm_sec", "tm_min", "tm_hour", "tm_mday", "tm_mon",
        "tm_year", "tm_wday", "tm_yday", "tm_msec", "tm_usec"
    };
    const u32 want[10] = { sec, min, hour, mday, mon, year, wday, yday, msec, usec };
    unsigned i;
    for (i = 0; i < 10; i++) {
        u32 got = ppcx_rd32(ea + i * 4u);
        if (got != want[i]) {
            fprintf(stderr, "hle: %s %s = %u, expected %u\n", what, names[i], (unsigned)got,
                    (unsigned)want[i]);
            return 1;
        }
    }
    return 0;
}

static int test_clock_models(void) {
    Cpu cpu;
    const PpcxClockState *s;
    const u64 epoch = PPCX_CLOCK_EPOCH_TICKS;
    const u64 step = (u64)PPCX_CLOCK_STEP_TICKS;
    const u32 out = PPCX_HLE_DATA_ADDR + 0x100u;
    u64 t;
    unsigned i;

    ppcx_hle_clock_reset();
    s = ppcx_hle_clock_state();
    if (s->system_ticks != 0u || s->system_time_calls != 0u || s->time_calls != 0u) {
        return fail("clock reset state");
    }
    if (s->system_info.bus_clock_speed != PPCX_CLOCK_BUS_HZ) return fail("clock reset bus speed");
    if (s->system_info.core_clock_speed != PPCX_CLOCK_CORE_HZ) return fail("clock reset core speed");
    if (s->system_info.base_time != epoch) return fail("clock reset base time");

    /* OSGetSystemTime returns a 64-bit tick count in r3:r4 and advances the
     * virtual timebase by one 60 Hz frame per read. */
    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_u64("coreinit.OSGetSystemTime", &cpu, step) != 0) return 1;
    s = ppcx_hle_clock_state();
    if (s->system_time_calls != 1u || s->last_system_time != step || s->system_ticks != step) {
        return fail("OSGetSystemTime first read state");
    }
    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_u64("coreinit.OSGetSystemTime", &cpu, 2u * step) != 0) return 1;
    s = ppcx_hle_clock_state();
    if (s->system_time_calls != 2u || s->system_ticks != 2u * step) {
        return fail("OSGetSystemTime second read state");
    }

    /* OSGetTime adds the virtual epoch, so its high word is non-zero; this
     * catches a model that only writes r3. */
    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_u64("coreinit.OSGetTime", &cpu, epoch + 3u * step) != 0) return 1;
    s = ppcx_hle_clock_state();
    if (s->time_calls != 1u || s->last_time != epoch + 3u * step || s->system_ticks != 3u * step) {
        return fail("OSGetTime first read state");
    }
    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_u64("coreinit.OSGetTime", &cpu, epoch + 4u * step) != 0) return 1;
    s = ppcx_hle_clock_state();
    if (s->time_calls != 2u || s->system_ticks != 4u * step) {
        return fail("OSGetTime second read state");
    }

    /* OSGetSystemInfo writes a 0x20-byte OSSystemInfo record at the reserved
     * HLE data page and does not advance the clock. */
    memset(arena + PPCX_HLE_DATA_ADDR, 0xaa, PPCX_SYSTEM_INFO_SIZE);
    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_r3("coreinit.OSGetSystemInfo", &cpu, PPCX_SYSTEM_INFO_ADDR) != 0) return 1;
    s = ppcx_hle_clock_state();
    if (s->system_info_calls != 1u || s->system_ticks != 4u * step) {
        return fail("OSGetSystemInfo state");
    }
    if (s->system_info.bus_clock_speed != PPCX_CLOCK_BUS_HZ) return fail("system info bus speed");
    if (s->system_info.core_clock_speed != PPCX_CLOCK_CORE_HZ) return fail("system info core speed");
    if (s->system_info.base_time != epoch) return fail("system info base time");
    if (ppcx_rd32(PPCX_SYSTEM_INFO_ADDR + 0x00u) != PPCX_CLOCK_BUS_HZ) return fail("guest bus speed");
    if (ppcx_rd32(PPCX_SYSTEM_INFO_ADDR + 0x04u) != PPCX_CLOCK_CORE_HZ) return fail("guest core speed");
    if (ppcx_rd64(PPCX_SYSTEM_INFO_ADDR + 0x08u) != epoch) return fail("guest base time");
    for (i = 0x10u; i < PPCX_SYSTEM_INFO_SIZE; i += 4u) {
        if (ppcx_rd32(PPCX_SYSTEM_INFO_ADDR + i) != 0u) return fail("system info reserved bytes");
    }
    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_r3("coreinit.OSGetSystemInfo", &cpu, PPCX_SYSTEM_INFO_ADDR) != 0) return 1;
    s = ppcx_hle_clock_state();
    if (s->system_info_calls != 2u || s->system_ticks != 4u * step) {
        return fail("OSGetSystemInfo repeat state");
    }

    /* OSTicksToCalendarTime consumes r3:r4 ticks and a pointer in r5. */
    memset(arena + out, 0xaa, PPCX_CALENDAR_TIME_SIZE + 4u);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = (u32)(epoch >> 32);
    cpu.gpr[4] = (u32)epoch;
    cpu.gpr[5] = out;
    if (check_dispatch_void("coreinit.OSTicksToCalendarTime", &cpu) != 0) return 1;
    if (check_calendar_fields(out, 0u, 0u, 0u, 1u, 0u, 2026u, 4u, 0u, 0u, 0u, "epoch") != 0) {
        return 1;
    }
    if (arena[out + PPCX_CALENDAR_TIME_SIZE] != 0xaau) {
        return fail("OSTicksToCalendarTime wrote past OSCalendarTime");
    }
    s = ppcx_hle_clock_state();
    if (s->calendar_calls != 1u || s->calendar_negative != 0u || s->last_calendar_ea != out ||
        s->last_calendar_ticks != epoch || s->system_ticks != 4u * step) {
        return fail("OSTicksToCalendarTime epoch state");
    }

    t = epoch + (u64)PPCX_CLOCK_TIMER_HZ + (u64)(PPCX_CLOCK_TIMER_HZ / 2u);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = (u32)(t >> 32);
    cpu.gpr[4] = (u32)t;
    cpu.gpr[5] = out;
    if (check_dispatch_void("coreinit.OSTicksToCalendarTime", &cpu) != 0) return 1;
    if (check_calendar_fields(out, 1u, 0u, 0u, 1u, 0u, 2026u, 4u, 0u, 500u, 0u, "second") != 0) {
        return 1;
    }

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0xffffffffu;
    cpu.gpr[4] = 0xffffffffu;
    cpu.gpr[5] = out;
    if (check_dispatch_void("coreinit.OSTicksToCalendarTime", &cpu) != 0) return 1;
    if (check_calendar_fields(out, 0u, 0u, 0u, 1u, 0u, 2000u, 6u, 0u, 0u, 0u, "negative") != 0) {
        return 1;
    }
    s = ppcx_hle_clock_state();
    if (s->calendar_calls != 3u || s->calendar_negative != 1u || s->last_calendar_ticks != 0u) {
        return fail("OSTicksToCalendarTime negative state");
    }

    /* Reset must clear the counters and the timebase but keep the synthetic
     * hardware description. */
    ppcx_hle_clock_reset();
    s = ppcx_hle_clock_state();
    if (s->system_ticks != 0u || s->system_time_calls != 0u || s->time_calls != 0u ||
        s->system_info_calls != 0u || s->calendar_calls != 0u || s->calendar_negative != 0u) {
        return fail("clock reset did not clear state");
    }
    if (s->system_info.bus_clock_speed != PPCX_CLOCK_BUS_HZ) return fail("clock reset lost bus speed");
    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_u64("coreinit.OSGetSystemTime", &cpu, step) != 0) return 1;
    return 0;
}

static int test_tls_model(void) {
    const u32 index = 0x800u;
    const PpcxTlsState *s;
    Cpu cpu;
    unsigned i;

    /* Reset clears both the counters and the zero-filled TLS block. */
    memset(arena + PPCX_TLS_DATA_ADDR, 0xaa, PPCX_TLS_DATA_SIZE);
    ppcx_hle_tls_reset();
    s = ppcx_hle_tls_state();
    if (s->calls != 0u || s->resolved != 0u || s->invalid_module != 0u ||
        s->invalid_offset != 0u || s->last_index_ea != 0u || s->last_result != 0u) {
        return fail("TLS reset did not clear state");
    }
    for (i = 0; i < PPCX_TLS_DATA_SIZE; i++) {
        if (arena[PPCX_TLS_DATA_ADDR + i] != 0u) return fail("TLS reset did not clear block");
    }

    /* A valid index returns block + offset; the returned memory is writable
     * and distinct for different offsets. */
    ppcx_wr32(index + 0u, PPCX_TLS_MODULE_ID);
    ppcx_wr32(index + 4u, 4u);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = index;
    if (check_dispatch_r3("coreinit.__tls_get_addr", &cpu,
                          PPCX_TLS_DATA_ADDR + 4u) != 0) {
        return 1;
    }
    ppcx_wr32(cpu.gpr[3], 0x12345678u);
    s = ppcx_hle_tls_state();
    if (s->calls != 1u || s->resolved != 1u || s->invalid_module != 0u ||
        s->invalid_offset != 0u || s->last_index_ea != index ||
        s->last_module != PPCX_TLS_MODULE_ID || s->last_offset != 4u ||
        s->last_result != PPCX_TLS_DATA_ADDR + 4u) {
        return fail("TLS first resolution state");
    }
    if (ppcx_rd32(PPCX_TLS_DATA_ADDR + 4u) != 0x12345678u) {
        return fail("TLS returned pointer is not writable");
    }

    ppcx_wr32(index + 4u, 0u);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = index;
    if (check_dispatch_r3("coreinit.__tls_get_addr", &cpu,
                          PPCX_TLS_DATA_ADDR) != 0) {
        return 1;
    }
    ppcx_wr32(cpu.gpr[3], 0xabcdef01u);
    if (ppcx_rd32(PPCX_TLS_DATA_ADDR + 4u) != 0x12345678u) {
        return fail("TLS variables alias");
    }

    ppcx_wr32(index + 4u, 8u);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = index;
    if (check_dispatch_r3("coreinit.__tls_get_addr", &cpu,
                          PPCX_TLS_DATA_ADDR + 8u) != 0) {
        return 1;
    }
    ppcx_wr32(cpu.gpr[3], 0x0badf00du);
    s = ppcx_hle_tls_state();
    if (s->calls != 3u || s->resolved != 3u ||
        ppcx_rd32(PPCX_TLS_DATA_ADDR) != 0xabcdef01u ||
        ppcx_rd32(PPCX_TLS_DATA_ADDR + 8u) != 0x0badf00du) {
        return fail("TLS third resolution state");
    }

    /* Unknown module and out-of-range offsets return NULL, not a wild
     * pointer, and leave the valid block untouched. */
    ppcx_wr32(index + 0u, PPCX_TLS_MODULE_ID + 1u);
    ppcx_wr32(index + 4u, 4u);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = index;
    if (check_dispatch_r3("coreinit.__tls_get_addr", &cpu, 0u) != 0) return 1;
    s = ppcx_hle_tls_state();
    if (s->calls != 4u || s->resolved != 3u || s->invalid_module != 1u ||
        s->invalid_offset != 0u || s->last_module != PPCX_TLS_MODULE_ID + 1u ||
        s->last_offset != 4u || s->last_result != 0u) {
        return fail("TLS invalid module state");
    }

    ppcx_wr32(index + 0u, PPCX_TLS_MODULE_ID);
    ppcx_wr32(index + 4u, PPCX_TLS_DATA_SIZE);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = index;
    if (check_dispatch_r3("coreinit.__tls_get_addr", &cpu, 0u) != 0) return 1;
    s = ppcx_hle_tls_state();
    if (s->calls != 5u || s->resolved != 3u || s->invalid_offset != 1u ||
        s->last_offset != PPCX_TLS_DATA_SIZE || s->last_result != 0u) {
        return fail("TLS invalid offset state");
    }

    /* The last aligned word is still valid and writable. */
    ppcx_wr32(index + 4u, PPCX_TLS_DATA_SIZE - 4u);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = index;
    if (check_dispatch_r3("coreinit.__tls_get_addr", &cpu,
                          PPCX_TLS_DATA_ADDR + PPCX_TLS_DATA_SIZE - 4u) != 0) {
        return 1;
    }
    ppcx_wr32(cpu.gpr[3], 0x13579bdfu);
    s = ppcx_hle_tls_state();
    if (s->calls != 6u || s->resolved != 4u ||
        ppcx_rd32(PPCX_TLS_DATA_ADDR + PPCX_TLS_DATA_SIZE - 4u) != 0x13579bdfu) {
        return fail("TLS last-word state");
    }

    ppcx_hle_tls_reset();
    s = ppcx_hle_tls_state();
    if (s->calls != 0u || s->resolved != 0u || s->invalid_module != 0u ||
        s->invalid_offset != 0u || s->last_index_ea != 0u || s->last_result != 0u) {
        return fail("TLS final reset state");
    }
    if (ppcx_rd32(PPCX_TLS_DATA_ADDR) != 0u ||
        ppcx_rd32(PPCX_TLS_DATA_ADDR + PPCX_TLS_DATA_SIZE - 4u) != 0u) {
        return fail("TLS final reset block");
    }
    return 0;
}

static int test_ghs_data_model(void) {
    static const u32 info[3] = { 0x00000004u, 0x00040002u, 0x00080002u };
    u32 i;
    u32 j;

    memset(arena + PPCX_GHS_DATA_ADDR, 0xaa, PPCX_GHS_DATA_SIZE);
    ppcx_hle_ghs_reset();

    if (ppcx_hle_data_addr("coreinit.__gh_FOPEN_MAX") != PPCX_GH_FOPEN_MAX_ADDR) {
        return fail("__gh_FOPEN_MAX data address");
    }
    if (ppcx_hle_data_addr("coreinit._iob") != PPCX_GHS_IOB_ADDR) {
        return fail("_iob data address");
    }
    if (ppcx_hle_data_addr("coreinit._iob_lock") != 0u ||
        ppcx_hle_data_addr("coreinit._iobX") != 0u ||
        ppcx_hle_data_addr("other._iob") != 0u ||
        ppcx_hle_data_addr(NULL) != 0u) {
        return fail("unmodeled data import accepted");
    }

    if (ppcx_rd16(PPCX_GH_FOPEN_MAX_ADDR) != PPCX_GH_FOPEN_MAX) {
        return fail("__gh_FOPEN_MAX value");
    }
    for (i = 0; i < PPCX_GHS_IOB_COUNT; i++) {
        u32 base = PPCX_GHS_IOB_ADDR + i * PPCX_GHS_IOBUF_SIZE;
        for (j = 0; j < PPCX_GHS_IOBUF_SIZE; j += 4u) {
            u32 got = ppcx_rd32(base + j);
            u32 want = (i < 3u && j == PPCX_GHS_IOB_INFO_OFFSET) ? info[i] : 0u;
            if (got != want) {
                fprintf(stderr, "hle: _iob[%u]+0x%02X = 0x%08X, expected 0x%08X\n",
                        (unsigned)i, (unsigned)j, (unsigned)got, (unsigned)want);
                return 1;
            }
        }
    }

    /* Reset restores the whole page, not only the fields read above. */
    ppcx_wr16(PPCX_GH_FOPEN_MAX_ADDR, 0xffffu);
    ppcx_wr32(PPCX_GHS_IOB_ADDR, 0xdeadbeefu);
    memset(arena + PPCX_GHS_DATA_ADDR + 0x800, 0xaa, 0x10);
    ppcx_hle_ghs_reset();
    if (ppcx_rd16(PPCX_GH_FOPEN_MAX_ADDR) != PPCX_GH_FOPEN_MAX) {
        return fail("GHS reset did not restore FOPEN_MAX");
    }
    if (ppcx_rd32(PPCX_GHS_IOB_ADDR) != 0u ||
        ppcx_rd32(PPCX_GHS_IOB_ADDR + PPCX_GHS_IOB_INFO_OFFSET) != info[0]) {
        return fail("GHS reset did not restore _iob");
    }
    for (i = 0; i < 0x10u; i++) {
        if (arena[PPCX_GHS_DATA_ADDR + 0x800 + i] != 0u) {
            return fail("GHS reset did not clear the data page");
        }
    }
    return 0;
}

static int test_input_models(void) {
    static const char *const gyro_noops[] = {
        "vpad.VPADEnableGyroAccRevise",
        "vpad.VPADDisableGyroDirRevise",
        "vpad.VPADSetGyroAccReviseParam",
        "vpad.VPADSetGyroDirection",
        "vpad.VPADSetGyroZeroDriftMode",
    };
    Cpu cpu;
    const PpcxInputState *s;
    unsigned i;

    ppcx_hle_input_reset();
    s = ppcx_hle_input_state();
    if (s->kpad_initialized != 0u || s->kpad_read_calls != 0u || s->vpad_read_calls != 0u) {
        return fail("input reset state");
    }

    /* KPAD before init reports UNINITIALIZED and must not touch the buffer. */
    memset(arena + 0x800, 0xaa, 0x100);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x800u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x8f0u;
    if (check_dispatch_r3("padscore.KPADReadEx", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x8f0u) != 0xfffffffbU) return fail("KPAD uninitialized error");
    if (arena[0x800] != 0xaau) return fail("KPAD uninitialized read wrote a sample");
    s = ppcx_hle_input_state();
    if (s->kpad_invalid_reads != 1u || s->kpad_last_chan != 0u || s->kpad_last_error != 0xfffffffbU) {
        return fail("KPAD uninitialized state");
    }

    /* KPADInitEx(NULL, 64) is rejected, but KPADInitEx(NULL, 0) is the
     * documented null-buffer form and must initialize the model. */
    memset(&cpu, 0, sizeof cpu);
    cpu.gpr[4] = 64u;
    if (check_dispatch_void("padscore.KPADInitEx", &cpu) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->kpad_initialized != 0u || s->kpad_invalid_init != 1u) return fail("KPADInitEx accepted NULL buffer with count");

    memset(&cpu, 0, sizeof cpu);
    if (check_dispatch_void("padscore.KPADInitEx", &cpu) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->kpad_initialized != 1u || s->kpad_init_calls != 2u) return fail("KPADInitEx NULL,0 state");
    if (s->kpad_init_buffer != 0u || s->kpad_init_count != 0u) return fail("KPADInitEx NULL,0 arguments");

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x700u;
    cpu.gpr[4] = 64u;
    if (check_dispatch_void("padscore.KPADInitEx", &cpu) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->kpad_initialized != 1u || s->kpad_init_calls != 3u) return fail("KPADInitEx state");
    if (s->kpad_init_buffer != 0x700u || s->kpad_init_count != 64u) return fail("KPADInitEx arguments");

    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_r3("padscore.KPADGetMplsWorkSize", &cpu, PPCX_INPUT_MPLS_WORK_SIZE) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->kpad_mpls_size_calls != 1u) return fail("KPADGetMplsWorkSize count");

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x900u;
    if (check_dispatch_void("padscore.KPADSetMplsWorkarea", &cpu) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->kpad_mpls_workarea_calls != 1u || s->kpad_mpls_workarea != 0x900u) {
        return fail("KPADSetMplsWorkarea state");
    }

    /* There is no KPAD/WPAD controller: a non-zero count still produces no
     * sample and leaves the guest buffer untouched. */
    memset(arena + 0x800, 0xaa, 0x100);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x800u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x8f0u;
    if (check_dispatch_r3("padscore.KPADReadEx", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x8f0u) != 0xffffffffU) return fail("KPAD read error is not NO_SAMPLES");
    if (arena[0x800] != 0xaau) return fail("KPAD read wrote a sample");
    s = ppcx_hle_input_state();
    if (s->kpad_no_samples != 1u || s->kpad_last_error != 0xffffffffU) return fail("KPAD read state");

    memset(arena + 0x100, 0xcc, 0x100);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 1u;
    cpu.gpr[4] = 0x100u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x1f0u;
    if (check_dispatch_r3("padscore.KPADReadEx", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x1f0u) != 0xffffffffU) return fail("KPAD channel 1 error is not NO_SAMPLES");
    if (arena[0x100] != 0xccu) return fail("KPAD channel 1 wrote a sample");
    s = ppcx_hle_input_state();
    if (s->kpad_no_samples != 2u) return fail("KPAD channel 1 count");

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x100u;
    cpu.gpr[5] = 0u;
    cpu.gpr[6] = 0x1f0u;
    if (check_dispatch_r3("padscore.KPADReadEx", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x1f0u) != 0xffffffffU) return fail("KPAD zero-count error is not NO_SAMPLES");
    if (arena[0x100] != 0xccu) return fail("KPAD zero-count read wrote a sample");

    /* A NULL status pointer is harmless while no sample is produced. */
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x1f0u;
    if (check_dispatch_r3("padscore.KPADReadEx", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x1f0u) != 0xffffffffU) return fail("KPAD NULL buffer error");
    s = ppcx_hle_input_state();
    if (s->kpad_invalid_reads != 1u || s->kpad_no_samples != 4u) return fail("KPAD NULL buffer count");

    /* A channel outside 0..3 is an invalid controller, not merely no data. */
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = PPCX_INPUT_KPAD_CHANNELS;
    cpu.gpr[4] = 0x100u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x1f0u;
    if (check_dispatch_r3("padscore.KPADReadEx", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x1f0u) != 0xfffffffeU) return fail("KPAD invalid-channel error");
    if (arena[0x100] != 0xccu) return fail("KPAD invalid-channel read wrote a sample");
    s = ppcx_hle_input_state();
    if (s->kpad_invalid_reads != 2u || s->kpad_last_chan != PPCX_INPUT_KPAD_CHANNELS) {
        return fail("KPAD invalid-channel state");
    }

    /* VPAD channel 0 returns one zero-filled 0xAC-byte sample. */
    memset(arena + 0x200, 0xbb, 0xc0);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x200u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x2b0u;
    if (check_dispatch_r3("vpad.VPADRead", &cpu, 1u) != 0) return 1;
    if (ppcx_rd32(0x2b0u) != 0u) return fail("VPAD read error is not OK");
    for (i = 0; i < PPCX_VPAD_STATUS_SIZE; i++) {
        if (arena[0x200 + i] != 0u) return fail("VPAD sample is not zero-filled");
    }
    for (i = 0x2b4; i < 0x2c0; i++) {
        if (arena[i] != 0xbbu) return fail("VPAD read wrote past the error word");
    }
    s = ppcx_hle_input_state();
    if (s->vpad_samples_returned != 1u || s->vpad_last_error != 0u) return fail("VPAD read state");

    memset(arena + 0x300, 0xdd, 0xc0);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 1u;
    cpu.gpr[4] = 0x300u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x3b0u;
    if (check_dispatch_r3("vpad.VPADRead", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x3b0u) != 0xffffffffU) return fail("VPAD channel 1 error");
    if (arena[0x300] != 0xddu) return fail("VPAD channel 1 wrote a sample");
    s = ppcx_hle_input_state();
    if (s->vpad_no_samples != 1u) return fail("VPAD channel 1 count");

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 2u;
    cpu.gpr[4] = 0x300u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x3b0u;
    if (check_dispatch_r3("vpad.VPADRead", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x3b0u) != 0xfffffffeU) return fail("VPAD invalid-channel error");
    s = ppcx_hle_input_state();
    if (s->vpad_invalid_reads != 1u) return fail("VPAD invalid-channel count");

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x200u;
    cpu.gpr[5] = 0u;
    cpu.gpr[6] = 0x2b0u;
    if (check_dispatch_r3("vpad.VPADRead", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x2b0u) != 0xffffffffU) return fail("VPAD zero-count error");

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0u;
    cpu.gpr[5] = 1u;
    cpu.gpr[6] = 0x2b0u;
    if (check_dispatch_r3("vpad.VPADRead", &cpu, 0u) != 0) return 1;
    if (ppcx_rd32(0x2b0u) != 0xffffffffU) return fail("VPAD NULL buffer error");
    s = ppcx_hle_input_state();
    if (s->vpad_invalid_reads != 2u) return fail("VPAD NULL buffer count");

    /* Touch calibration copies eight bytes and tolerates aliasing. */
    for (i = 0; i < PPCX_VPAD_TOUCH_SIZE; i++) arena[0x400 + i] = (u8)(1u + i);
    memset(arena + 0x410, 0xee, PPCX_VPAD_TOUCH_SIZE);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x410u;
    cpu.gpr[5] = 0x400u;
    if (check_dispatch_void("vpad.VPADGetTPCalibratedPoint", &cpu) != 0) return 1;
    for (i = 0; i < PPCX_VPAD_TOUCH_SIZE; i++) {
        if (arena[0x410 + i] != (u8)(1u + i)) return fail("VPAD touch copy is wrong");
    }
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x400u;
    cpu.gpr[5] = 0x400u;
    if (check_dispatch_void("vpad.VPADGetTPCalibratedPoint", &cpu) != 0) return 1;
    for (i = 0; i < PPCX_VPAD_TOUCH_SIZE; i++) {
        if (arena[0x400 + i] != (u8)(1u + i)) return fail("VPAD touch aliasing corrupted the sample");
    }
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0u;
    cpu.gpr[5] = 0x400u;
    if (check_dispatch_void("vpad.VPADGetTPCalibratedPoint", &cpu) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->vpad_touch_calls != 2u || s->vpad_touch_invalid != 1u) return fail("VPAD touch state");

    /* Sampling callback returns the previous pointer and never fires. */
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x1111u;
    if (check_dispatch_r3("vpad.VPADSetSamplingCallback", &cpu, 0u) != 0) return 1;
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x2222u;
    if (check_dispatch_r3("vpad.VPADSetSamplingCallback", &cpu, 0x1111u) != 0) return 1;
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 1u;
    cpu.gpr[4] = 0x3333u;
    if (check_dispatch_r3("vpad.VPADSetSamplingCallback", &cpu, 0u) != 0) return 1;
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 2u;
    cpu.gpr[4] = 0x4444u;
    if (check_dispatch_r3("vpad.VPADSetSamplingCallback", &cpu, 0u) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->vpad_sampling_callbacks[0] != 0x2222u || s->vpad_sampling_callbacks[1] != 0x3333u) {
        return fail("VPAD sampling callback state");
    }
    if (s->vpad_sampling_callback_invalid != 1u || s->last_callback != 0x4444u) {
        return fail("VPAD sampling callback invalid state");
    }

    /* GamePad rumble is accepted and discarded; invalid patterns are errors. */
    for (i = 0; i < 4; i++) arena[0x500 + i] = (u8)(0x0fu & (i + 1u));
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x500u;
    cpu.gpr[5] = 4u;
    if (check_dispatch_r3("vpad.VPADControlMotor", &cpu, 0u) != 0) return 1;
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0u;
    cpu.gpr[5] = 0u;
    if (check_dispatch_r3("vpad.VPADControlMotor", &cpu, 0u) != 0) return 1;
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0u;
    cpu.gpr[5] = 4u;
    if (check_dispatch_r3("vpad.VPADControlMotor", &cpu, 0xffffffffu) != 0) return 1;
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    if (check_dispatch_void("vpad.VPADStopMotor", &cpu) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->vpad_motor_calls != 2u || s->vpad_motor_invalid != 1u || s->vpad_stop_motor_calls != 1u) {
        return fail("VPAD motor state");
    }

    /* The five gyro configuration calls are counted and preserve the CPU. */
    for (i = 0; i < sizeof(gyro_noops) / sizeof(gyro_noops[0]); i++) {
        memset(&cpu, 0x5a, sizeof cpu);
        cpu.gpr[3] = 0u;
        cpu.gpr[4] = 2u;
        if (check_dispatch_void(gyro_noops[i], &cpu) != 0) return 1;
    }
    s = ppcx_hle_input_state();
    if (s->vpad_gyro_calls != 5u || s->last_gyro_chan != 0u || s->last_gyro_mode != 2u) {
        return fail("VPAD gyro state");
    }

    /* WPAD has no controller and no Bluetooth sync backend. */
    memset(arena + 0x510, 0xaa, 4);
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0x510u;
    if (check_dispatch_r3("padscore.WPADProbe", &cpu, 0xffffffffu) != 0) return 1;
    if (ppcx_rd32(0x510u) != 0u) return fail("WPADProbe extension is not zero");
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    cpu.gpr[4] = 0u;
    if (check_dispatch_r3("padscore.WPADProbe", &cpu, 0xffffffffu) != 0) return 1;
    memset(&cpu, 0x5a, sizeof cpu);
    if (check_dispatch_r3("padscore.WPADStartSyncDevice", &cpu, 0u) != 0) return 1;
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 1u;
    if (check_dispatch_void("padscore.WPADEnableURCC", &cpu) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->wpad_probe_calls != 2u || s->wpad_sync_calls != 1u || s->wpad_urcc_calls != 1u) {
        return fail("WPAD state");
    }
    if (s->last_probe_chan != 0u || s->last_probe_extension != 0u || s->last_urcc_enable != 1u) {
        return fail("WPAD argument state");
    }

    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0u;
    if (check_dispatch_r3("vpadbase.VPADBASEGetHeadphoneStatus", &cpu, 0u) != 0) return 1;
    s = ppcx_hle_input_state();
    if (s->headphone_calls != 1u) return fail("headphone status count");

    /* Reset must clear every input counter and callback slot. */
    ppcx_hle_input_reset();
    s = ppcx_hle_input_state();
    if (s->kpad_initialized != 0u || s->kpad_read_calls != 0u || s->vpad_read_calls != 0u) {
        return fail("input reset did not clear the state");
    }
    if (s->vpad_sampling_callbacks[0] != 0u || s->vpad_sampling_callbacks[1] != 0u) {
        return fail("input reset did not clear callbacks");
    }
    return 0;
}

static int test_default_heap(void) {
    Cpu cpu;
    const PpcxDefaultHeapState *s;
    u32 first;
    u32 aligned;

    memset(&cpu, 0, sizeof cpu);
    ppcx_hle_default_heap_reset();
    s = ppcx_hle_default_heap_state();
    if (s->next != PPCX_HLE_HEAP_DATA_START ||
        s->limit != PPCX_HLE_HEAP_ADDR + PPCX_HLE_HEAP_SIZE) {
        return fail("default heap reset state");
    }

    cpu.gpr[3] = 0x30u;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMAllocFromDefaultHeap")) {
        return fail("default heap alloc not modeled");
    }
    first = cpu.gpr[3];
    if (first != PPCX_HLE_HEAP_DATA_START) return fail("default heap first allocation address");
    s = ppcx_hle_default_heap_state();
    if (s->allocations != 1u || s->total_bytes != 0x30u ||
        s->next != PPCX_HLE_HEAP_DATA_START + 0x30u) {
        return fail("default heap first allocation bookkeeping");
    }

    cpu.gpr[3] = 0x80u;
    cpu.gpr[4] = 0x100u;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMAllocFromDefaultHeapEx")) {
        return fail("default heap aligned alloc not modeled");
    }
    aligned = cpu.gpr[3];
    if (aligned != PPCX_HLE_HEAP_DATA_START + 0x100u) return fail("default heap alignment");
    s = ppcx_hle_default_heap_state();
    if (s->last_align != 0x100u || s->next != aligned + 0x80u) {
        return fail("default heap aligned bookkeeping");
    }

    cpu.gpr[3] = 0x10u;
    cpu.gpr[4] = 6u;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMAllocFromDefaultHeapEx") || cpu.gpr[3] != 0u) {
        return fail("default heap rejected non-power-of-two alignment");
    }

    cpu.gpr[3] = 0u;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMAllocFromDefaultHeap") || cpu.gpr[3] != 0u) {
        return fail("default heap zero-size result");
    }
    s = ppcx_hle_default_heap_state();
    if (s->zero_size != 1u) return fail("default heap zero-size bookkeeping");

    cpu.gpr[3] = PPCX_HLE_HEAP_SIZE;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMAllocFromDefaultHeap") || cpu.gpr[3] != 0u) {
        return fail("default heap exhaustion");
    }
    s = ppcx_hle_default_heap_state();
    if (s->failures != 2u) return fail("default heap failure bookkeeping");

    cpu.gpr[3] = first;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMFreeToDefaultHeap")) {
        return fail("default heap free not modeled");
    }
    s = ppcx_hle_default_heap_state();
    if (s->frees != 1u || s->next != aligned + 0x80u) {
        return fail("default heap free must not recycle in the diagnostic model");
    }

    cpu.gpr[3] = 8u;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMGetBaseHeapHandle") ||
        cpu.gpr[3] != PPCX_HLE_HEAP_HANDLE_FG_ADDR) {
        return fail("frame heap foreground base handle");
    }
    cpu.gpr[3] = 99u;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMGetBaseHeapHandle") || cpu.gpr[3] != 0u) {
        return fail("frame heap unknown base handle");
    }

    cpu.gpr[3] = PPCX_HLE_HEAP_HANDLE_FG_ADDR;
    cpu.gpr[4] = 0x100u;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMGetAllocatableSizeForFrmHeapEx")) {
        return fail("frame heap allocatable not modeled");
    }
    if (cpu.gpr[3] != PPCX_HLE_HEAP_ADDR + PPCX_HLE_HEAP_SIZE - (PPCX_HLE_HEAP_DATA_START + 0x200u)) {
        return fail("frame heap allocatable size");
    }

    cpu.gpr[3] = PPCX_HLE_HEAP_HANDLE_FG_ADDR;
    cpu.gpr[4] = 0x20u;
    cpu.gpr[5] = 0x100u;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.MEMAllocFromFrmHeapEx") ||
        cpu.gpr[3] != PPCX_HLE_HEAP_DATA_START + 0x200u) {
        return fail("frame heap aligned allocation");
    }
    s = ppcx_hle_default_heap_state();
    if (s->next != PPCX_HLE_HEAP_DATA_START + 0x220u) {
        return fail("frame heap allocation bookkeeping");
    }

    if (ppcx_hle_data_addr("coreinit.MEMAllocFromDefaultHeap") != PPCX_HLE_DEFAULT_HEAP_ALLOC_ADDR ||
        ppcx_hle_data_addr("coreinit.MEMAllocFromDefaultHeapEx") != PPCX_HLE_DEFAULT_HEAP_ALLOC_EX_ADDR ||
        ppcx_hle_data_addr("coreinit.MEMFreeToDefaultHeap") != PPCX_HLE_DEFAULT_HEAP_FREE_ADDR) {
        return fail("default heap function-pointer data addresses");
    }
    if (!ppcx_hle_data_is_fnptr_addr(PPCX_HLE_DEFAULT_HEAP_ALLOC_ADDR) ||
        !ppcx_hle_data_is_fnptr_addr(PPCX_HLE_DEFAULT_HEAP_ALLOC_EX_ADDR) ||
        !ppcx_hle_data_is_fnptr_addr(PPCX_HLE_DEFAULT_HEAP_FREE_ADDR) ||
        ppcx_hle_data_is_fnptr_addr(PPCX_GH_FOPEN_MAX_ADDR)) {
        return fail("default heap function-pointer address predicate");
    }
    return 0;
}

static int test_fast_mutex(void) {
    Cpu cpu;
    Cpu before;
    const PpcxFastMutexState *s;
    u32 i;

    memset(arena + 0x1000, 0xaa, PPCX_FAST_MUTEX_SIZE + 4u);
    ppcx_hle_fast_mutex_reset();
    s = ppcx_hle_fast_mutex_state();
    if (s->inits != 0u || s->locks != 0u || s->unlocks != 0u || s->trylocks != 0u) {
        return fail("fast mutex reset state");
    }

    /* Init is void and writes the wut-defined OSFastMutex layout. */
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x1000u;
    cpu.gpr[4] = 0x12345678u;
    before = cpu;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.OSFastMutex_Init")) {
        return fail("OSFastMutex_Init not modeled");
    }
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("OSFastMutex_Init changed registers");
    if (ppcx_rd32(0x1000u) != PPCX_FAST_MUTEX_TAG) return fail("OSFastMutex tag");
    if (ppcx_rd32(0x1004u) != 0x12345678u) return fail("OSFastMutex name");
    for (i = 8u; i < PPCX_FAST_MUTEX_SIZE; i += 4u) {
        if (ppcx_rd32(0x1000u + i) != 0u) return fail("OSFastMutex fields not cleared");
    }
    if (arena[0x1000u + PPCX_FAST_MUTEX_SIZE] != 0xaau) return fail("OSFastMutex wrote past its size");
    s = ppcx_hle_fast_mutex_state();
    if (s->inits != 1u || s->last_mutex != 0x1000u || s->last_name != 0x12345678u) {
        return fail("OSFastMutex_Init state");
    }

    /* Lock and Unlock are void counted no-ops in the single-thread model. */
    memset(&cpu, 0x5a, sizeof cpu);
    before = cpu;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.OSFastMutex_Lock")) {
        return fail("OSFastMutex_Lock not modeled");
    }
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("OSFastMutex_Lock changed registers");
    memset(&cpu, 0x5a, sizeof cpu);
    before = cpu;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.OSFastMutex_Unlock")) {
        return fail("OSFastMutex_Unlock not modeled");
    }
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("OSFastMutex_Unlock changed registers");
    s = ppcx_hle_fast_mutex_state();
    if (s->locks != 1u || s->unlocks != 1u) return fail("OSFastMutex lock/unlock counts");

    /* TryLock returns TRUE and changes only r3. */
    memset(&cpu, 0x5a, sizeof cpu);
    cpu.gpr[3] = 0x1000u;
    before = cpu;
    if (!ppcx_hle_dispatch_named(&cpu, "coreinit.OSFastMutex_TryLock")) {
        return fail("OSFastMutex_TryLock not modeled");
    }
    if (cpu.gpr[3] != 1u) return fail("OSFastMutex_TryLock result");
    cpu.gpr[3] = before.gpr[3];
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("OSFastMutex_TryLock changed other registers");
    s = ppcx_hle_fast_mutex_state();
    if (s->trylocks != 1u) return fail("OSFastMutex_TryLock count");

    ppcx_hle_fast_mutex_reset();
    s = ppcx_hle_fast_mutex_state();
    if (s->inits != 0u || s->locks != 0u || s->unlocks != 0u || s->trylocks != 0u) {
        return fail("fast mutex reset did not clear counters");
    }
    return 0;
}

static int test_exact_names(void) {
    Cpu cpu;
    Cpu before;

    memset(&cpu, 0x55, sizeof cpu);
    before = cpu;
    if (ppcx_hle_dispatch_named(&cpu, "proc_ui.ProcUIInitEx") != 0) return fail("nonimplemented function reported implemented");
    if (memcmp(&cpu, &before, sizeof cpu) != 0) return fail("unknown function changed CPU");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSGetCoreIdSuffix") != 0) return fail("non-exact match was accepted");
    if (ppcx_hle_dispatch_named(&cpu, "other.OSGetCoreId") != 0) return fail("incorrect module accepted");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSBlockMoveX") != 0) return fail("non-exact memory import accepted");
    if (ppcx_hle_dispatch_named(&cpu, "other.OSBlockMove") != 0) return fail("incorrect memory module accepted");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSGetSystemTimeEx") != 0) return fail("non-exact clock import accepted");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSGetSystemInfoEx") != 0) return fail("non-exact system-info import accepted");
    if (ppcx_hle_dispatch_named(&cpu, "other.OSGetSystemTime") != 0) return fail("incorrect clock module accepted");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.__tls_get_addrX") != 0) return fail("non-exact TLS import accepted");
    if (ppcx_hle_dispatch_named(&cpu, "other.__tls_get_addr") != 0) return fail("incorrect TLS module accepted");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSFastMutex_InitX") != 0) return fail("non-exact mutex import accepted");
    if (ppcx_hle_dispatch_named(&cpu, "other.OSFastMutex_Init") != 0) return fail("incorrect mutex module accepted");
    if (ppcx_hle_dispatch_named(&cpu, "coreinit.OSGetTick") != 0) return fail("unmodeled OSGetTick accepted");
    if (ppcx_hle_dispatch_named(&cpu, "padscore.KPADRead") != 0) return fail("unmodeled KPADRead accepted");
    if (ppcx_hle_dispatch_named(&cpu, "vpad.VPADInit") != 0) return fail("unmodeled VPADInit accepted");
    if (ppcx_hle_dispatch_named(&cpu, "vpad.VPADGetTPCalibratedPointEx") != 0) return fail("non-exact VPAD import accepted");
    if (ppcx_hle_dispatch_named(&cpu, "padscore.WPADControlMotor") != 0) return fail("unmodeled WPAD audio/motor import accepted");
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
    if (test_procui_lifecycle() != 0) return 1;
    if (test_clock_models() != 0) return 1;
    if (test_tls_model() != 0) return 1;
    if (test_ghs_data_model() != 0) return 1;
    if (test_default_heap() != 0) return 1;
    if (test_fast_mutex() != 0) return 1;
    if (test_input_models() != 0) return 1;
    if (test_exact_names() != 0) return 1;
    puts("hle: core identity, memory/cache, proc_ui lifecycle, virtual clock/system info, TLS, GHS data, default heap, fast mutex and input models, exact matching and register preservation OK");
    return 0;
}
