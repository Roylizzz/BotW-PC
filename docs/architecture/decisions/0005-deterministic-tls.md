# 5. Deterministic single-module TLS for headless runs

- **Date:** 2026-10-20
- **Status:** accepted (implementation policy under ADR-0002)

## Context

The v208 module imports `coreinit.__tls_get_addr` and reaches it from **3,371
REL24 call sites in 2,770 functions**. It is the highest-count unmodeled
import family after the memory/cache and clock blocks. The import is the
PowerPC TLS resolver: a caller loads the address of a `TLSIndex` (two 32-bit
words, module id and symbol offset) and calls `__tls_get_addr`, which returns
a pointer to the current thread's copy of that symbol.

The real module is a single main module with a zero-filled `.thrbss` section
(three symbols, offsets 0, 4 and 8) and no `.tdata`. The image builder already
materializes the section as ordinary BSS, but it could not resolve the six
TLS relocation sites, so the `TLSIndex` words stayed at their unrelocated
values (`module = 0`, `offset = 4/8/0`).

The prototype has one guest context and no scheduler, dynamic loader or real
threads. Modeling per-thread TLS copies or host thread-local storage would add
state the runtime cannot own consistently, while leaving the import
unresolved keeps a large call family behind a counted no-op.

## Decision

Use one deterministic TLS policy for the prototype:

1. **One module, one thread.** The main module id is **1**. There is exactly
   one TLS block per run, shared by every guest call; no dynamic modules and
   no per-thread copies are modeled.
2. **Block location.** The block is the upper part of the reserved HLE data
   page: `PPCX_TLS_DATA_ADDR = 0x00090100`, `PPCX_TLS_DATA_SIZE = 0x00000F00`
   (`0x90100..0x91000`). It is zero-initialized by
   `ppcx_hle_tls_reset()` at the start of each run. The `OSSystemInfo` record
   keeps the lower 0x100 bytes at `0x00090000`.
3. **Image relocations.** `R_PPC_DTPMOD32` writes module id **1**.
   `R_PPC_DTPREL32` writes **`symbol.value + addend`**. The measured v208
   `TLSIndex` objects already contain plain offsets 0/4/8, so this model does
   **not** apply the generic PowerPC `-0x8000` DTP bias. The builder rejects
   non-`STT_TLS` symbols, initialized TLS (`.tdata`) and any symbol whose
   offset/size does not fit the 0xF00-byte block.
4. **Resolver ABI.** `coreinit.__tls_get_addr` reads the 8-byte `TLSIndex`
   from `r3` through the checked guest-memory accessors, requires module **1**
   and `offset < 0xF00`, and returns `0x00090100 + offset` in `r3`. An unknown
   module or out-of-range offset returns **0** deterministically. The handler
   records call/resolution counters and the last index for the native tests.
5. **Out of scope.** Initialized TLS (`.tdata`), TLS destructors, dynamic
   module ids, real threads, per-thread copies and host-thread-local storage
   remain unmodeled. `.thrbss` is still mapped as ordinary zero-filled BSS;
   the HLE block is a runtime convenience, not a loader replacement.

## Consequences

- The six v208 TLS relocations now resolve in the image (`3` `DTPMOD32` and
  `3` `DTPREL32`), and translated code can call `__tls_get_addr` without
  hitting an unmodeled import.
- TLS pointers are stable for a run and distinct for the measured offsets.
  Every run starts from a zero-filled block, so headless output remains
  byte-identical.
- A guest that writes through a returned pointer sees its own value on later
  calls in the same run. A second run does not inherit it.
- The model is single-threaded; it says nothing about thread creation,
  scheduling, TLS initialization or game compatibility. A future threading
  model must replace the single block with per-thread storage while keeping
  the guest ABI.

## Evidence

- Image run pinned to the recorded v208 SHA-256: 31 segments, 43,155,811
  bytes, 278,749 `R_PPC_ADDR32`, **3 `R_PPC_DTPMOD32` + 3 `R_PPC_DTPREL32`
  applied**, 889,935 executable-section sites left to the recompiler. The
  resulting words are `1/4` at `0x1045CC14`, `1/8` at `0x1045CC1C` and `1/0`
  at `0x1045CC24`.
- Native contract test (`tests/hle/test_hle.c`): reset/zeroing, module and
  offset validation, writable returned memory, non-aliasing offsets, invalid
  module/offset returning 0, last valid word and final reset.
- Compiled checked-memory test (`tests/mem/run.js`): a valid `TLSIndex`
  resolves to `0x00090104` through the real region map, the returned word is
  writable, an invalid module returns 0, and an unmapped index faults with
  the standard exit-9 diagnostic.
- Real v208 demo: `0x03F92140` (14 instructions, loads the
  `s_memoryRouter__14hkMemoryRouter` index at `0x1045CC14`, calls
  `__tls_get_addr`, stores `r31` at the result and returns the pointer)
  prints `HLE modeled #1: coreinit.__tls_get_addr (import 143),
  r3=0x00090104` and exits 0 under `PPCX_HLE_STRICT=1` with
  `PPCX_HLE_TRACE=1`.
