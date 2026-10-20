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
    if (ppcx_hle_dispatch_named(cpu, name) != 1) return fail("input import unresolved");
    if (cpu->gpr[3] != expected) {
        fprintf(stderr, "hle: %s returned 0x%08x, expected 0x%08x\n", name, cpu->gpr[3], expected);
        return 1;
    }
    before.gpr[3] = expected;
    if (memcmp(cpu, &before, sizeof *cpu) != 0) return fail("input import changed unexpected registers");
    return 0;
}

static int check_dispatch_void(const char *name, Cpu *cpu) {
    Cpu before = *cpu;
    if (ppcx_hle_dispatch_named(cpu, name) != 1) return fail("void input import unresolved");
    if (memcmp(cpu, &before, sizeof *cpu) != 0) return fail("void input import changed registers");
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
    if (test_input_models() != 0) return 1;
    if (test_exact_names() != 0) return 1;
    puts("hle: core identity, memory/cache, proc_ui lifecycle and input models, exact matching and register preservation OK");
    return 0;
}
