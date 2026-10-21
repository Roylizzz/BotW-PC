# runtime (prototype)

Host-side runtime for the C code produced by `tools/ppcx translate`.

It provides:

* the flat guest address space (`ppcx_memory`, one arena covering the
  addresses the RPX is linked for),
* the load-image mapper (`src/runtime/src/ppcx_image.c`): maps
  `build/ppcx/image.bin` — every allocated section of the user's own RPX,
  data relocations applied, `.bss` zero-filled — into the arena after
  validating structure, segment order, guest-arena bounds and the payload
  checksum, so a rejected blob never leaves a partial image behind,
* the checked guest-memory model (`src/runtime/src/ppcx_mem.c`): a region
  map (stack plus every loaded segment, each with the ELF write permission)
  behind all guest accessors; an access outside every region or a write to a
  read-only region stops with a diagnostic and exit code 9 instead of
  silently reading or writing unrelated arena bytes,
* the function registry and its dispatcher (`ppcx_dispatch`),
* diagnostics with full register context for untranslated instructions and
  unregistered targets,
* the HLE entry point for imported system functions, with exact-name coreinit
  core identity/flat-memory/cache/clock/system-info/TLS models, the proc_ui
  lifecycle and explicit diagnostics for everything else. This is not yet
  full Cafe OS, initialized TLS or multi-core scheduling.

## Build (local prototype)

The generated translation unit and the load image are derived works of the
user's own game dump: they live in `build/` and are never committed.

```powershell
# 1. translate something (writes build/ppcx/gen.c)
node tools/ppcx/ppcx.js translate --rpx <your U-King-v208.rpx> --fn 0x031FA4CC --follow 2

# 2. build the load image (sections, .bss, data relocations)
node tools/ppcx/ppcx.js image --rpx <your U-King-v208.rpx> --out build/ppcx

# 3. compile with the local TCC
tcc -I src/runtime/include -DPPCX_NO_FMA `
    src/runtime/src/ppcx_runtime.c src/runtime/src/ppcx_mem.c `
    src/runtime/src/ppcx_hle.c src/runtime/src/ppcx_image.c `
    src/runtime/src/main.c build/ppcx/gen.c -o build/ppcx/ppcx.exe

# 4. run (maps the image when PPCX_IMAGE points at it)
$env:PPCX_IMAGE = "build\ppcx\image.bin"
build/ppcx/ppcx.exe
```

`-DPPCX_NO_FMA` is only needed on toolchains whose C library lacks
`fma`/`fmaf` (the local TCC + msvcrt combination). The fallback rounds the
multiply-add twice; that only shows up on rare inputs and is fine for the
prototype.

## Environment variables

* `PPCX_IMAGE=<path>` – map a `PPCXIMG1` load image into the arena before the
  entry point runs (fatal — exit code 8 with a diagnostic on stderr — if the
  blob is invalid),
* `PPCX_HLE_TRACE=1` – log every emulated system call,
* `PPCX_HLE_STRICT=1` – abort on the first **unimplemented** system call; implemented models remain available.
* `PPCX_DISPATCH_TRACE=1` – log every control transfer that goes through the
  dispatcher (the entry point, indirect calls and import trampolines).

## Checked guest memory (exit code 9)

`ppcx_run` installs the checked memory model before the entry point:
`ppcx_mem_reset` activates it with the stack mapped (`PPCX_INITIAL_STACK`
down 1 MiB), and the image loader registers every segment of a
`PPCX_IMAGE` blob as a region. The loader calls the entry point with a valid
ABI frame, so the initial SP is `PPCX_INITIAL_STACK - 16` (inside the mapped
stack, 16-byte aligned): a standard prologue can save LR at `SP+4` of that
frame. With SP exactly at the top, the save lies outside the region and the
first real prologue faults — the `tests/boot` fixture gates that behavior.
From then on every guest access made by translated code (plain,
byte-reversed, string/multiple-register helpers and `dcbz`) must fall
**entirely inside one region**; anything else prints

```
ppcx: guest memory fault: read of 4 byte(s) at 0x00020000 is not inside any mapped region
```

followed by the register context and terminates with exit code 9. Without
`PPCX_IMAGE` only the stack is mapped, so a function that reads data faults
loudly instead of reading unrelated zero bytes.

Regions also carry permissions: the stack is read/write, and every loaded
segment is writable only when its ELF section flags included `SHF_WRITE`
(the loader reads that bit from the blob). A write to a read-only region has
its own diagnostic and the same exit code 9:

```
ppcx: guest memory fault: write of 4 byte(s) at 0x00010000 is not allowed (region "image" at 0x00010000+64 is read-only)
```

On v208, `.text` (plus `.syscall`, the import tables and the allocated
metadata) is read-only, while `.rodata`, `.data`, `.module_id`, `.bss` and
`.thrbss` are writable. Executable permission is not enforced: translated
code is native C and never fetches guest bytes.

Harnesses that never call `ppcx_mem_reset` (the ISA oracle harness) keep the
raw flat-address behavior; the compiled checked-memory tests live in
`tests/mem` and the loader harness in `tests/loader` proves that a loaded
image is exactly the registered region set, with the permissions derived
from the blob flags.

## Loader error codes

`ppcx_image_load_file` / `ppcx_image_load_memory` return 0 on success and
write a one-line diagnostic otherwise:

| Code | Meaning |
| ---- | ------- |
| -1 | invalid arguments, arena not allocated, or out of memory |
| -2 | blob shorter than the header, or bad magic |
| -3 | bad segment count |
| -4 | the segment table runs past the end of the blob |
| -5 | empty segment, unknown segment flags, or a segment outside the guest arena |
| -6 | segments out of order or overlapping |
| -7 | a segment payload runs past the end of the blob |
| -8 | payload checksum (Fletcher-32) mismatch |
| -9 | file I/O error |
| -10 | a segment overlaps a live region or the region table is full (checked model active) |

Every check runs before the first byte is written, and segment registration
runs before the mapping loop, so a rejected blob never leaves a partial
image in the arena. On -10 the map may already contain the segments
registered before the failing one; the caller is expected to abort the load
(the runtime exits with code 8). The compiled harness in `tests/loader`
covers the format, the checks and the Fletcher-32 boundaries against the
tool that writes blobs; `tools/ppcx/README.md` documents how the image is
built.

## Implemented HLE subset (synthetic tests)

Forty original, exact-name functions are implemented in `ppcx_hle.c`:
seventeen `coreinit` calls, five `proc_ui` lifecycle calls and eighteen
`padscore`/`vpad`/`vpadbase` input calls. The four clock/system-info additions
are the deterministic virtual clock described below.

* **Core identity:** `OSGetCoreCount` (3), `OSGetCoreId` (1),
  `OSGetMainCoreId` (1), `OSIsMainCore` (true). The runtime's only guest CPU
  is assigned to retail Wii U main core 1 **by explicit prototype
  convention**. This is not actual threading, affinity or scheduling.
* **Memory and cache:** `OSBlockMove` (memmove-like, overlap supported,
  returns `dst`; its `flush` argument is a no-op because the flat arena has
  no data cache), `OSBlockSet` (fill, `uint8_t` value, returns `dst`),
  `coreinit.memcpy` and `coreinit.memset` (returns `dst`), `DCZeroRange`
  (zeroes the 0x20-byte cache blocks that cover the range, through
  `ppcx_dcbz`), `DCFlushRange` / `DCFlushRangeNoSync` / `DCInvalidateRange`
  (typed no-ops on the coherent arena that still validate their range;
  `DCFlushRange` runs a host fence) and `OSMemoryBarrier` (host fence).
* **proc_ui lifecycle:** `ProcUIInit` (void; records a non-NULL save callback
  and rejects NULL), `ProcUIProcessMessages` (returns 0
  `IN_FOREGROUND` while initialized and 3 `EXITING` before init or after
  shutdown), `ProcUIDrawDoneRelease` (counted no-op),
  `ProcUIRegisterCallback` (void; records up to 16 `(type, fn, param,
  priority)` registrations) and `ProcUIShutdown` (void; ends the lifecycle).
  The headless model has no HOME menu, OS message pump or callback
  execution: callbacks are recorded for diagnostics and never invoked, and
  `block` is recorded but has no scheduling effect. The real API documents
  the `block = false` return as undefined; this model still reports the
  status so the behavior is deterministic. Signatures and status values were
  checked against devkitPro/wut `proc_ui/procui.h`.
* **Clock and system info:** `OSGetSystemTime` and `OSGetTime` return a 64-bit
  `OSTime` in `r3:r4`. They follow a deterministic virtual clock, not host
  wall time: the machine boots at a fixed **2026-01-01 00:00:00** epoch (9497
  days after the 2000-01-01 `OSTime` epoch), and every successful read advances
  one virtual 60 Hz frame (`62,156,250 / 60 = 1,035,937` timer ticks).
  `OSGetSystemTime` returns ticks since virtual boot; `OSGetTime` adds the
  epoch. `OSGetSystemInfo` returns a pointer to a 0x20-byte `OSSystemInfo` at
  the reserved HLE data page `0x00090000`: `busClockSpeed = 248,625,000`,
  `coreClockSpeed = 1,243,125,000`, `baseTime` = the virtual epoch, and zero
  reserved bytes. `OSTicksToCalendarTime` converts an `OSTime` since
  2000-01-01 into the ten 32-bit `OSCalendarTime` fields (0x28 bytes, UTC,
  Sunday = 0); negative inputs clamp to 2000-01-01. The clock model is a
  placeholder for scheduling and timer-interrupt behavior; see
  [ADR-0004](../../docs/architecture/decisions/0004-deterministic-virtual-clock.md).
* **Input (headless placeholder):** the `padscore` calls `KPADGetMplsWorkSize`
  (returns a model-chosen 0x100-byte work size), `KPADInitEx`,
  `KPADSetMplsWorkarea` and `KPADReadEx`; `WPADProbe` (always
  `WPAD_ERROR_NO_CONTROLLER`, writes extension type 0), `WPADStartSyncDevice`
  (FALSE) and `WPADEnableURCC` (counted no-op); the `vpad` calls `VPADRead`,
  `VPADGetTPCalibratedPoint`, `VPADSetSamplingCallback`, `VPADControlMotor`,
  `VPADStopMotor`, `VPADEnableGyroAccRevise`,
  `VPADDisableGyroDirRevise`, `VPADSetGyroAccReviseParam`,
  `VPADSetGyroDirection` and `VPADSetGyroZeroDriftMode`; and
  `vpadbase.VPADBASEGetHeadphoneStatus` (0, no headphones). One neutral
  virtual GamePad is present on VPAD channel 0: a read with `count >= 1`
  writes one zero-filled `VPADStatus` (0xAC bytes, no buttons, centered
  sticks, invalid touch) and returns one sample. No KPAD/WPAD controller is
  present, so `KPADReadEx` returns 0 samples with `KPAD_ERROR_NO_SAMPLES`
  (-1) after init (or `KPAD_ERROR_UNINITIALIZED`, -5, before it; channels
  outside 0..3 return `KPAD_ERROR_INVALID_CONTROLLER`, -2) and leaves the
  guest buffer untouched. `VPADGetTPCalibratedPoint` performs an identity
  copy of the 8-byte `VPADTouchData` (aliasing-safe), sampling callbacks are
  recorded and never invoked, motor patterns are accepted and discarded, and
  the gyro setters are counted no-ops. The policy is recorded in
  [ADR-0003](../../docs/architecture/decisions/0003-headless-input-policy.md).
  This is not host input or controller emulation; the sizes and signatures
  were checked against wut `padscore/kpad.h`,
  `padscore/wpad.h`, `vpad/input.h` and `vpadbase/base.h`.

Values returned to the guest use r3 (PowerPC ABI), except the two `OSTime`
getters, which return the 64-bit value in `r3:r4`; `OSGetSystemInfo` returns
its guest pointer in r3. The `proc_ui` void functions, `OSTicksToCalendarTime`
and the input void calls (`KPADInitEx`, `KPADSetMplsWorkarea`,
`VPADGetTPCalibratedPoint`, `VPADStopMotor`, the five gyro setters and
`WPADEnableURCC`) leave the general-purpose registers untouched. The memory
services validate the whole range against the checked region map before
touching memory, so a rejected operation has no partial effects and stops with
the deterministic diagnostic and exit code 9. Zero-length ranges are no-ops
and are never dereferenced.
`VPADRead` validates its 0xAC-byte destination and `VPADGetTPCalibratedPoint`
validates its 8-byte source and destination before writing; `KPADReadEx`
writes only the 4-byte error word because the model produces no KPAD sample.
`OSBlockMove`'s documented overlap guarantee is implemented explicitly
because the local TCC's `memmove` was measured to copy forward and corrupt an
overlapping destination. Signatures and return contracts were checked against
devkitPro/wut `coreinit/core.h`, `memory.h`, `cache.h`, `time.h`,
`systeminfo.h`, `proc_ui/procui.h`, `padscore/kpad.h`, `padscore/wpad.h`,
`vpad/input.h` and `vpadbase/base.h`.

The v208 import census gives the measured priority: `OSBlockMove` 6,834
REL24 call sites (+2 address-taken), `coreinit.memcpy` 408 (+2),
`OSMemoryBarrier` 330 (+2), `OSBlockSet` 295 (+2), `DCZeroRange` 119,
`DCFlushRange` 77, `DCFlushRangeNoSync` 29, `DCInvalidateRange` 9,
`coreinit.memset` 84, and the five `proc_ui` functions with 10 call sites
total (`ProcUIRegisterCallback` 6, the other four 1 each). The six callback
registration sites use phases 5, 1, 0, 0, 1 and one caller-supplied value;
the model stores the raw numbers and does not interpret or invoke them.
The four clock imports cover `OSGetSystemTime` 481 REL24 sites plus 2
address-taken sites, `OSGetTime` 10, `OSGetSystemInfo` 17 and
`OSTicksToCalendarTime` 2; `OSSleepTicks` (7 sites) stays unimplemented
because it requires a scheduler. Ten functions combine `OSGetSystemInfo`
with another clock call, so the system-info record and the virtual clock are
tested together.
The eighteen input imports cover 22 REL24 sites: the four KPAD calls 1 each;
WPAD `Probe` 2, `EnableURCC` 1 and `StartSyncDevice` 1; VPAD `Read` 1,
`GetTPCalibratedPoint` 3, `ControlMotor` 2, `SetSamplingCallback` 1,
`StopMotor` 1 and the five gyro setters 1 each; `VPADBASEGetHeadphoneStatus`
1. The Wii Remote audio/motor path remains unmodeled: `WENCGetEncodeData` 1,
`WPADCanSendStreamData` 1, `WPADControlMotor` 2, `WPADControlSpeaker` 3 and
`WPADSendStreamData` 1. Measured on v208 on 2026-10-20: the wrapper at
`0x030C7558` calls `WPADProbe` with channel 0, prints
`HLE modeled #1: padscore.WPADProbe (import 355), r3=0xFFFFFFFF`, returns
`r3 = 0` (no controller) and exits 0 under `PPCX_HLE_STRICT=1`; the wrapper
at `0x030D730C` calls `VPADBASEGetHeadphoneStatus`, prints
`HLE modeled #1: vpadbase.VPADBASEGetHeadphoneStatus (import 438),
r3=0x00000000`, returns 0 and also exits 0. Both runs use the 31-segment /
43,155,811-byte image and 13/12 translated instructions respectively.

Two real v208 clock paths were measured on 2026-10-20 with the same image and
`PPCX_HLE_STRICT=1`. The 11-instruction wrapper at `0x030CB524` calls
`OSGetSystemInfo`, prints
`HLE modeled #1: coreinit.OSGetSystemInfo (import 78), r3=0x00090000`, exits
0, and its disassembly computes `busClockSpeed / 4 = 62,156,250` in r4 after
zeroing r3 (a 64-bit `r3:r4` result; the runtime trace prints only r3). The
16-instruction static initializer at `0x0308E41C` calls `OSGetSystemTime`,
prints `HLE modeled #1: coreinit.OSGetSystemTime (import 79), r3=0x00000000`
(the high word; the first low word is `0x000FCEA1`), stores both words at
`0x105495A0/A4`, zeroes `0x105495A8/AC`, and exits 0. These runs prove the
imports resolve and the HLE data page is readable under the real image; the
64-bit values and calendar fields are gated by the native and memory tests.

The TLS resolver landed on 2026-10-20 under
[ADR-0005](../architecture/decisions/0005-deterministic-tls.md). The image
builder now applies the three `R_PPC_DTPMOD32` sites as module `1` and the
three `R_PPC_DTPREL32` sites as offsets `4`, `8` and `0`; the runtime owns one
zero-filled **0xF00-byte** block at `0x00090100` above the `OSSystemInfo`
record. `coreinit.__tls_get_addr` validates the 8-byte `TLSIndex`, requires
module 1 and an offset below 0xF00, and returns `0x00090100 + offset`; an
unknown module or out-of-range offset returns 0. This is one module and one
thread, not initialized `.tdata` or real per-thread storage. The 14-instruction
v208 function at `0x03F92140` prints
`HLE modeled #1: coreinit.__tls_get_addr (import 143), r3=0x00090104` and
exits 0 under `PPCX_HLE_STRICT=1`.

All other imports remain unimplemented, including filesystem, threading, GX2
and the Wii Remote audio/motor path. In diagnostic mode they are counted but
still return as no-ops (not a valid game execution path). Set
`PPCX_HLE_STRICT=1` to stop on such calls. Exact module-qualified lookup means
similarly named symbols in other modules cannot accidentally be considered
implemented.

Run the synthetic native tests without game content:

```sh
cc -std=c11 -Wall -Wextra -Werror -I src/runtime/include src/runtime/src/ppcx_hle.c tests/hle/test_hle.c -o hle_check
./hle_check
```

The contract test runs on a raw host arena (`ppcx_mem_active` is 0, with a
stubbed checker) and covers the 41 models, exact-name matching and register
preservation, including the 64-bit clock returns, the system-info and
calendar layouts, TLS resolution and reset, the proc_ui lifecycle, callback
table and re-init, and the input init/read, touch, callback, motor, gyro and
WPAD contracts. The compiled `tests/mem` harness links the same `ppcx_hle.c`
with the real `ppcx_mem.c` and region map: it checks the copy, fill and block
semantics, the reserved HLE data page, the guest `OSSystemInfo` record and
valid/invalid TLS indices, and runs five extra child processes in which a
read-only destination, an unmapped destination, an unmapped source, a
read-only `DCZeroRange` block and an unmapped TLS index must each exit with
code 9 and the exact diagnostic. The workflow is manual-only; dispatch
it from the Actions tab. It runs the HLE contract test, `tests/mem` and the
compiled ISA/loader/boot harnesses. Do not count modeled identity, memory/cache,
lifecycle or input calls as evidence of full Cafe OS compatibility.

## Synthetic boot fixture

`node tests/boot/run.js` compiles this runtime (together with `ppcx_mem.c`,
`ppcx_hle.c` and `ppcx_image.c`), a generated translation unit and a small
driver, then boots a game-free RPX from `tests/boot/fixture.js` headless. The
fixture exercises the real pipeline end to end — analysis, translation, load
image, checked memory and HLE — in nine scenarios: modeled calls through a
direct `bl` and through an address-taken import's dispatcher trampoline (with
`PPCX_HLE_TRACE`/`PPCX_DISPATCH_TRACE` checkpoints), an unmodeled import in
diagnostic mode, `PPCX_HLE_STRICT=1` (exit 5 with the register dump), a
pointer-only getter, a cross-range tail `b` that must run the mid-body start
the analysis discovered (`r3 = 2` only if the jump skips `addi r3,0,0x40`), a
computed `bctr` inline-table switch that must dispatch through its `b` entry
and return `r3 = 0x11`, the five modeled `proc_ui` lifecycle calls with a
post-shutdown `EXITING` status (`r3 = 0x47`), an unmapped read (exit 9) and the
same boot without `PPCX_IMAGE` (exit 9 at the first data read). Every
stderr/stdout line and every guest-memory probe is compared with the authored
expectations, and the boot run must repeat byte-identically.
