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

/* Deterministic virtual clock and system-info model.
 *
 * This is not host wall time and not a timer interrupt. The virtual machine
 * boots at the fixed epoch 2026-01-01 00:00:00 (9497 days after the OSTime
 * epoch 2000-01-01). Every successful OSGetSystemTime/OSGetTime read advances
 * the timebase by one virtual 60 Hz frame; polling loops therefore make
 * progress while a run stays byte-identical from run to run. OSGetSystemTime
 * returns ticks since that virtual boot and OSGetTime adds the epoch offset,
 * so OSTicksToCalendarTime sees a coherent date.
 *
 * OSGetSystemInfo returns a 32-bit guest pointer to a 0x20-byte OSSystemInfo
 * record placed in the reserved HLE data page below the guest image. The
 * runtime maps that page with write permission; the record reports the Wii U
 * bus/core clock rates and the virtual epoch as baseTime. OSTicksToCalendarTime
 * converts ticks since 2000-01-01 into the ten big-endian 32-bit fields of
 * OSCalendarTime (0x28 bytes); negative inputs clamp to the epoch. The 64-bit
 * OSTime values use the PowerPC EABI register pair r3:r4.
 */
#define PPCX_CLOCK_BUS_HZ 248625000u
#define PPCX_CLOCK_CORE_HZ 1243125000u
#define PPCX_CLOCK_TIMER_HZ (PPCX_CLOCK_BUS_HZ / 4u)
#define PPCX_CLOCK_EPOCH_DAYS 9497u /* 2000-01-01 -> 2026-01-01 */
#define PPCX_CLOCK_EPOCH_TICKS \
    ((u64)PPCX_CLOCK_EPOCH_DAYS * 86400u * (u64)PPCX_CLOCK_TIMER_HZ)
#define PPCX_CLOCK_STEP_TICKS (PPCX_CLOCK_TIMER_HZ / 60u)
#define PPCX_CALENDAR_TIME_SIZE 0x28u /* wut OSCalendarTime */
#define PPCX_SYSTEM_INFO_SIZE 0x20u   /* wut OSSystemInfo */
#define PPCX_HLE_DATA_ADDR 0x00090000u
#define PPCX_HLE_DATA_SIZE 0x00001000u
#define PPCX_SYSTEM_INFO_ADDR PPCX_HLE_DATA_ADDR

typedef struct PpcxSystemInfo {
    u32 bus_clock_speed;
    u32 core_clock_speed;
    u64 base_time;
} PpcxSystemInfo;

typedef struct PpcxClockState {
    u64 system_ticks;
    u64 last_system_time;
    u64 last_time;
    u64 last_calendar_ticks;
    u32 system_time_calls;
    u32 time_calls;
    u32 system_info_calls;
    u32 calendar_calls;
    u32 calendar_negative;
    u32 last_calendar_ea;
    PpcxSystemInfo system_info;
} PpcxClockState;

const PpcxClockState *ppcx_hle_clock_state(void);
void ppcx_hle_clock_reset(void);

/* Deterministic single-thread TLS model.
 *
 * The load image resolves the main module's R_PPC_DTPMOD32 sites to module 1
 * and R_PPC_DTPREL32 sites to the symbol-relative offset. __tls_get_addr
 * validates the 8-byte TLSIndex (module, offset), then returns a pointer into
 * a zero-filled block reserved in the HLE data page. The block is part of the
 * existing 0x00090000 page, starts above the OSSystemInfo record, and is
 * cleared by ppcx_hle_tls_reset() at the start of each run.
 *
 * This models one thread and one module. Initialized TLS (.tdata), dynamic
 * modules and real thread-local copies are out of scope; the image builder
 * rejects TLS symbols that do not fit this block. The measured v208 TLSIndex
 * objects carry plain 0/4/8 offsets, so the handler uses base + offset rather
 * than the generic PowerPC -0x8000 DTP bias.
 */
#define PPCX_TLS_MODULE_ID 1u
#define PPCX_TLS_DATA_ADDR (PPCX_HLE_DATA_ADDR + 0x00000100u)
#define PPCX_TLS_DATA_SIZE (PPCX_HLE_DATA_SIZE - 0x00000100u)

typedef struct PpcxTlsState {
    u32 calls;
    u32 resolved;
    u32 invalid_module;
    u32 invalid_offset;
    u32 last_index_ea;
    u32 last_module;
    u32 last_offset;
    u32 last_result;
} PpcxTlsState;

const PpcxTlsState *ppcx_hle_tls_state(void);
void ppcx_hle_tls_reset(void);

/* GHS C-library data imports.
 *
 * coreinit exports __gh_FOPEN_MAX and _iob as data, not functions. The image
 * links ADDR16/HA relocation pairs at their use sites, so the translator must
 * resolve them to real storage addresses instead of the function trampoline
 * region. The layout follows the decaf GHS ABI: FOPEN_MAX is a 16-bit value
 * of 20 and _iob is 20 entries of 0x10 bytes (0x140 bytes total).
 *
 * _iob lives in its own page above the OSSystemInfo/TLS page. _iob[0..2] get
 * the info fields that coreinit's gh_iob_init writes for stdin/stdout/stderr;
 * no stream buffers or file descriptors are modeled. This is deterministic
 * storage for pointer arithmetic and flag inspection, not stdio emulation.
 */
#define PPCX_GHS_DATA_ADDR 0x00091000u
#define PPCX_GHS_DATA_SIZE 0x00001000u
#define PPCX_GH_FOPEN_MAX_ADDR PPCX_GHS_DATA_ADDR
#define PPCX_GH_FOPEN_MAX 20u
#define PPCX_GHS_IOBUF_SIZE 0x10u
#define PPCX_GHS_IOB_COUNT PPCX_GH_FOPEN_MAX
#define PPCX_GHS_IOB_INFO_OFFSET 0x0cu
#define PPCX_GHS_IOB_ADDR (PPCX_GHS_DATA_ADDR + 0x00000100u)
#define PPCX_GHS_IOB_SIZE (PPCX_GHS_IOB_COUNT * PPCX_GHS_IOBUF_SIZE)

/* Resolve a qualified coreinit data import (for example
 * "coreinit.__gh_FOPEN_MAX") to its modeled guest address. Returns 0 for
 * unmodeled data imports; callers must fail rather than silently aliasing. */
u32 ppcx_hle_data_addr(const char *qualified_name);

/* Reinitialize __gh_FOPEN_MAX and the _iob entries. */
void ppcx_hle_ghs_reset(void);

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
