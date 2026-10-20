#ifndef PPCX_HLE_H
#define PPCX_HLE_H

/* Original MIT code: typed subset of Wii U Cafe OS import behavior.
 * No external game data is required to compile or test this layer.
 */
#include "ppcx_abi.h"

/* Return 1 if implemented, 0 if not recognized. Unrecognized imports MUST
 * be handled by the caller's strict/diagnostic policy, never represented as
 * successful HLE implementations. */
int ppcx_hle_dispatch_named(Cpu *cpu, const char *qualified_name);

/* proc_ui lifecycle model.
 *
 * This is a deterministic, single-process model, not a HOME-menu integration:
 * ProcUIProcessMessages always reports PROCUI_STATUS_IN_FOREGROUND while the
 * library is initialized (and PROCUI_STATUS_EXITING otherwise). Registered
 * callbacks are recorded for diagnostics and are never invoked. The callback
 * table is cleared by ProcUIInit so a re-initialized lifecycle starts clean.
 */
#define PPCX_PROCUI_MAX_CALLBACKS 16u

typedef struct PpcxProcUiCallback {
    u32 type;
    u32 fn;
    u32 param;
    u32 priority;
} PpcxProcUiCallback;

typedef struct PpcxProcUiState {
    u32 initialized;
    u32 shutdown;
    u32 status; /* last ProcUIStatus observed (0 foreground .. 3 exiting) */
    u32 save_callback;
    u32 init_calls;
    u32 invalid_init;
    u32 process_messages_calls;
    u32 draw_done_releases;
    u32 shutdown_calls;
    u32 callbacks_registered;
    u32 callbacks_rejected;
    u32 callbacks_dropped;
    u32 callback_count;
    u32 last_block;
    PpcxProcUiCallback callbacks[PPCX_PROCUI_MAX_CALLBACKS];
} PpcxProcUiState;

const PpcxProcUiState *ppcx_hle_procui_state(void);
void ppcx_hle_procui_reset(void);

/* Input models (padscore KPAD/WPAD, vpad, vpadbase).
 *
 * This is a deterministic headless placeholder, not host input or controller
 * emulation. One neutral virtual GamePad is present on VPAD channel 0: a read
 * with count >= 1 writes one zero-filled status record (no buttons, centered
 * sticks, invalid touch) and returns one sample. No KPAD/WPAD controller is
 * present, so KPAD reads return no samples with KPAD_ERROR_NO_SAMPLES after
 * initialization, WPAD probes report "no controller", sync does not start,
 * and the GamePad reports no headphones. A future host backend can replace
 * this policy without changing the guest ABI.
 */
#define PPCX_KPAD_STATUS_SIZE 0xF0u /* wut KPADStatus */
#define PPCX_VPAD_STATUS_SIZE 0xACu /* wut VPADStatus */
#define PPCX_VPAD_TOUCH_SIZE 0x08u  /* wut VPADTouchData */
#define PPCX_INPUT_KPAD_CHANNELS 4u
#define PPCX_INPUT_VPAD_CHANNELS 2u
#define PPCX_INPUT_MPLS_WORK_SIZE 0x100u /* model-chosen, never dereferenced */

typedef struct PpcxInputState {
    u32 kpad_initialized;
    u32 kpad_init_calls;
    u32 kpad_invalid_init;
    u32 kpad_mpls_size_calls;
    u32 kpad_mpls_workarea_calls;
    u32 kpad_read_calls;
    u32 kpad_no_samples;
    u32 kpad_invalid_reads;
    u32 kpad_init_buffer;
    u32 kpad_init_count;
    u32 kpad_mpls_workarea;
    u32 kpad_last_chan;
    u32 kpad_last_count;
    u32 kpad_last_error;

    u32 vpad_read_calls;
    u32 vpad_samples_returned;
    u32 vpad_no_samples;
    u32 vpad_invalid_reads;
    u32 vpad_last_chan;
    u32 vpad_last_count;
    u32 vpad_last_error;
    u32 vpad_touch_calls;
    u32 vpad_touch_invalid;
    u32 vpad_sampling_callback_calls;
    u32 vpad_sampling_callback_invalid;
    u32 vpad_motor_calls;
    u32 vpad_motor_invalid;
    u32 vpad_stop_motor_calls;
    u32 vpad_gyro_calls;

    u32 wpad_probe_calls;
    u32 wpad_sync_calls;
    u32 wpad_urcc_calls;
    u32 headphone_calls;

    u32 vpad_sampling_callbacks[PPCX_INPUT_VPAD_CHANNELS];
    u32 last_callback;
    u32 last_probe_chan;
    u32 last_probe_extension;
    u32 last_urcc_enable;
    u32 last_gyro_chan;
    u32 last_gyro_mode;
} PpcxInputState;

const PpcxInputState *ppcx_hle_input_state(void);
void ppcx_hle_input_reset(void);

#endif
