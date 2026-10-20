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

#endif
