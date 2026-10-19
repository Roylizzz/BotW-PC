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
  core identity and flat-memory/cache models and explicit diagnostics for
  everything else. This is not yet full Cafe OS or multi-core scheduling.

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

Thirteen original, exact-name `coreinit` functions are implemented in
`ppcx_hle.c`:

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

All return values use r3 (PowerPC ABI). The memory services validate the
whole range against the checked region map before touching memory, so a
rejected operation has no partial effects and stops with the deterministic
diagnostic and exit code 9. Zero-length ranges are no-ops and are never
dereferenced. `OSBlockMove`'s documented overlap guarantee is implemented
explicitly because the local TCC's `memmove` was measured to copy forward and
corrupt an overlapping destination. Signatures and return contracts were
checked against devkitPro/wut `coreinit/core.h`, `memory.h` and `cache.h`.

The v208 import census gives the measured priority: `OSBlockMove` 6,834
REL24 call sites (+2 address-taken), `coreinit.memcpy` 408 (+2),
`OSMemoryBarrier` 330 (+2), `OSBlockSet` 295 (+2), `DCZeroRange` 119,
`DCFlushRange` 77, `DCFlushRangeNoSync` 29, `DCInvalidateRange` 9 and
`coreinit.memset` 84.

All other imports remain unimplemented, including `proc_ui.ProcUIInit`. In
diagnostic mode they are counted but still return as no-ops (not a valid game
execution path). Set `PPCX_HLE_STRICT=1` to stop on such calls. Exact
module-qualified lookup means similarly named symbols in other modules cannot
accidentally be considered implemented.

Run the synthetic native tests without game content:

```sh
cc -std=c11 -Wall -Wextra -Werror -I src/runtime/include src/runtime/src/ppcx_hle.c tests/hle/test_hle.c -o hle_check
./hle_check
```

The contract test runs on a raw host arena (`ppcx_mem_active` is 0, with a
stubbed checker). The compiled `tests/mem` harness links the same
`ppcx_hle.c` with the real `ppcx_mem.c` and region map: it checks the copy,
fill and block semantics and runs four extra child processes in which a
read-only destination, an unmapped destination, an unmapped source and a
read-only `DCZeroRange` block must each exit with code 9 and the exact
diagnostic. The workflow runs both the contract test and `tests/mem` on every
pull request. Do not count modeled identity or memory/cache calls as evidence
of full Cafe OS compatibility.

## Synthetic boot fixture

`node tests/boot/run.js` compiles this runtime (together with `ppcx_mem.c`,
`ppcx_hle.c` and `ppcx_image.c`), a generated translation unit and a small
driver, then boots a game-free RPX from `tests/boot/fixture.js` headless. The
fixture exercises the real pipeline end to end — analysis, translation, load
image, checked memory and HLE — in seven scenarios: modeled calls through a
direct `bl` and through an address-taken import's dispatcher trampoline (with
`PPCX_HLE_TRACE`/`PPCX_DISPATCH_TRACE` checkpoints), an unmodeled import in
diagnostic mode, `PPCX_HLE_STRICT=1` (exit 5 with the register dump), a
pointer-only getter, a cross-range tail `b` that must run the mid-body start
the analysis discovered (`r3 = 2` only if the jump skips `addi r3,0,0x40`),
an unmapped read (exit 9) and the same boot without `PPCX_IMAGE` (exit 9 at
the first data read). Every stderr/stdout line and every guest-memory probe
is compared with the authored expectations, and the boot run must repeat
byte-identically.
