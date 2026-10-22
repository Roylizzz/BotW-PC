# 7. Diagnostic default and frame heap models

- **Date:** 2026-10-22
- **Status:** accepted (implementation policy under ADR-0002)

## Context

The real v208 GraphicsSystem constructor calls the imported default-heap
functions through the `.dimport_coreinit` function-pointer cells, then asks
coreinit for the foreground frame-heap handle and allocates from it. A probe
started directly at `FUN_02C5E368` measured this chain:

```
HLE modeled #1: coreinit.MEMAllocFromDefaultHeap (import 36), r3=0x60001000
HLE modeled #4: coreinit.MEMGetBaseHeapHandle (import 49), r3=0x60000400
HLE modeled #5: coreinit.MEMGetAllocatableSizeForFrmHeapEx (import 48), r3=0x0FFFEC18
HLE modeled #6: coreinit.MEMAllocFromFrmHeapEx (import 39), r3=0x600013E8
```

Before these models existed, the first call stopped with exit 7 (unmodeled
data import), and the frame-heap path returned zero, which made the caller
dereference a null object at `0x0000000C`. The probe must be able to pass
through these early allocations to measure the next blocker, but the project
must not pretend that a bump arena is a Cafe OS heap.

## Decision

1. **Default-heap imports are four-byte function-pointer data cells.**
   `MEMAllocFromDefaultHeap`, `MEMAllocFromDefaultHeapEx` and
   `MEMFreeToDefaultHeap` resolve through `ppcx_hle_data_addr` to
   `0x00090020`, `0x00090024` and `0x00090028`. When the loader resolves one
   of those data imports, `ppcx_import_data_addr` writes the matching HLE
   trampoline into the cell, so guest code that loads the cell and executes
   `bctrl` reaches the same handlers as a direct call. The cells live in the
   free part of the first HLE page, below the TLS block.
2. **The model is a deterministic bump arena, not an allocator.** A single
   writable region at `0x60000000` with size `0x10000000` (256 MiB) serves
   both default and base frame-heap allocations. The first 4 KiB holds three
   synthetic `MEMFrmHeap` headers at stride `0x80`; data starts at
   `0x60001000`. Allocation rounds the cursor up to the requested power-of-two
   alignment, rejects invalid alignments, zero sizes and exhaustion, and never
   reuses freed memory. `MEMFreeToDefaultHeap` only counts the call.
3. **Base handles are synthetic but stable.**
   `MEMGetBaseHeapHandle(0/1/8)` returns `0x60000000`,
   `0x60000080` and `0x60000400` for MEM1, MEM2 and the foreground heap.
   The header words are written only when the checked-memory model is active,
   because the native contract test runs on a raw arena. The three frame-heap
   entry points share the bump cursor, so an allocation through one handle is
   visible to the others; that is a diagnostic simplification, not Cafe OS
   heap isolation.
4. **Stop at the modeled boundary.** `MEMGetAllocatableSizeForFrmHeapEx`
   reports the remaining aligned bytes in the arena. There is no frame
   head/tail free mode, no heap lock, no MEM1/MEM2 split, no `MEMCreateFrmHeap`
   and no reclaimer. Unknown handles return zero and allocate nothing.
5. **Do not use these models as boot evidence.** They exist to let early
   real-code probes advance to the next measured blocker. A real boot still
   needs a proper MEM heap implementation, a scheduler and the remaining
   coreinit services.

## Consequences

- The GraphicsSystem probe now passes the default and frame-heap calls and
  reaches a different fault: a null global at `0x10549724` that is normally
  initialized before GraphicsSystem by `main`/CRT, not by the heap model.
- The synthetic boot fixture gains a data-import function that loads the
  `MEMAllocFromDefaultHeap` cell and calls it through `bctrl`; the expected
  result is the first bump allocation at `0x60001000`. The native contract
  test covers allocation, alignment, exhaustion, free bookkeeping, the three
  data cells and the three base handles.
- `tests/real/probe.js` can seed roots from the v208 static-constructor table
  at `0x1045CC2C` (`--root-table`) and can batch-expand a discovery window
  (`--expand-window`). The table has 6,115 entries; translating all of them
  plus direct callees measured 6,259 functions, 602,967 instructions and
  33,670,752 generated C characters in about 1.4 s. TCC on Windows needs
  `-DPPCX_NO_FMA` for that unit.
- The model deliberately leaks freed memory and cannot be used for sustained
  gameplay, streaming or assets with meaningful lifetimes.

## Evidence

- Native contract test (`tests/hle/test_hle.c`): first allocation at
  `0x60001000`, `Ex` alignment at `0x60001100`, invalid alignment and
  exhaustion return zero, free does not recycle, the three data cells are
  recognized as function-pointer cells, and `MEMGetBaseHeapHandle(8)` returns
  `0x60000400`.
- Compiled `tests/boot` fixture: a new `memory` scenario loads the
  `coreinit.MEMAllocFromDefaultHeap` data cell, calls it through `bctrl` and
  returns `r3=0x60001000`; the harness reports 12 scenarios, 9 compiled
  entries, 63 transcript lines and 128 memory-probe lines.
- Real v208 probe (`tests/real/probe.js --entry 0x02C5E368`): the heap chain
  above succeeds; the next fault is the read at `0x0000000C` from
  `lr 0x030A8398`, with `r30=0`, after the caller loads a global pointer at
  `0x10549724`. Starting at `main` instead runs the CRT constructor table;
  the full-table unit translates 6,259 functions and reaches
  `0x0420CA64` as the next unregistered dispatch after the first few
  constructors.
- The probe artifacts and constructor table are derived from the user's own
  dump and stay under git-ignored `build/`; no game content is committed.
