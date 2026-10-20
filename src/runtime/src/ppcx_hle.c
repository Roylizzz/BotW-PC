/*
 * Small, exact-name Cafe OS HLE registry. MIT, original implementation.
 *
 * Models the core-identity calls used by this single-thread prototype (its
 * only guest context is pinned to Wii U main core 1), the guest-memory and
 * cache primitives whose contracts are purely mechanical, and the proc_ui
 * lifecycle, and the headless input services used by the input manager. It is
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
