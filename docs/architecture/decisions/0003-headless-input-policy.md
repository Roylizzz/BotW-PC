# 3. Headless input policy for the first runtime increment

- **Date:** 2026-10-20
- **Status:** accepted (implementation policy under ADR-0002)

## Context

The v208 module imports 18 non-audio input functions across `padscore`,
`vpad` and `vpadbase`: four KPAD initialization/polling calls, three WPAD
probe/sync/URCC calls, ten VPAD read/touch/callback/motor/gyro calls and
`VPADBASEGetHeadphoneStatus`. The runtime has no host input backend, no
Bluetooth stack, no rumble device and no scheduler. The first milestone needs
deterministic behavior that lets the translated game code proceed without
claiming controller emulation or full Cafe OS compatibility.

The measured game-side buffer geometry is authoritative for the ABI:
`KPADStatus` is 0xF0 bytes, `VPADStatus` is 0xAC bytes and `VPADTouchData` is
8 bytes (wut headers, confirmed by the v208 callers' offsets).

## Decision

Use one deterministic headless placeholder policy:

1. Present **one neutral virtual GamePad on VPAD channel 0**. `VPADRead` with
   `count >= 1` writes one zero-filled 0xAC-byte `VPADStatus` (no buttons,
   centered sticks, invalid touch) and returns one sample. Channel 1 reports
   no samples; channels outside 0..1 report an invalid controller.
2. Present **no KPAD/WPAD controller**. After `KPADInitEx`, `KPADReadEx`
   returns zero samples with `KPAD_ERROR_NO_SAMPLES` (-1) and leaves the
   guest buffer untouched; before initialization it returns
   `KPAD_ERROR_UNINITIALIZED` (-5), and a channel outside 0..3 returns
   `KPAD_ERROR_INVALID_CONTROLLER` (-2). `WPADProbe` returns -1
   (`WPAD_ERROR_NO_CONTROLLER`) and writes extension type 0 when given an
   output pointer; `WPADStartSyncDevice` returns FALSE.
3. Keep the remaining calls side-effect-free but observable:
   `VPADGetTPCalibratedPoint` performs an aliasing-safe identity copy of the
   8-byte touch record; `VPADSetSamplingCallback` records the pointer and
   returns the previous one without invoking it; `VPADControlMotor` accepts
   and discards a valid pattern (invalid arguments return -1) and
   `VPADStopMotor` is a counter; the five gyro setters are counted no-ops;
   `VPADBASEGetHeadphoneStatus` returns 0.
4. Reject malformed KPAD initialization (`buffer == NULL && count > 0`) and
   expose all counters/arguments through `PpcxInputState` for tests and
   diagnostics. Reset the state at the start of each `ppcx_run`.

This is a placeholder, not host input. A future backend may replace the
policy while keeping the guest ABI and the registry names unchanged.

## Consequences

- The native contract test can assert exact counts, buffer boundaries, error
  words and register preservation without a controller or a window.
- A GamePad-only game path is testable end to end; a title that requires a
  Wii Remote or Pro Controller is not supported by this increment.
- The Wii Remote audio/motor path (`WENCGetEncodeData`,
  `WPADCanSendStreamData`, `WPADControlMotor`, `WPADControlSpeaker`,
  `WPADSendStreamData`) remains unmodeled and must stay visible in strict
  mode.
- The policy is deliberately conservative: it does not claim host input,
  controller compatibility, Bluetooth synchronization or rendering.
