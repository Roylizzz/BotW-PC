# Static recompiler prototype: pipeline, census and first translated function

- **Date:** 2026-10-18
- **Game version:** Wii U update v208 (`code/U-King.rpx`)
- **Tooling:** own `tools/ppcx` (Node) + `src/runtime` (C, TCC 0.9.27
  locally), Ghidra 12.1.4 census used for comparison only
- **Contributor:** @Roylizzz
- **Source:** own copy, analyzed locally

## Question

ADR-0002 recommends option A (static recompilation + own HLE). Can a
self-written PowerPC → C recompiler consume the RPX directly and reach a
point where *real* module code runs on the PC with observable results, and
what are the measured coverage numbers and the remaining gaps towards a
first GX2 frame?

## Findings

1. **Pipeline.** `tools/rpxinfo` (parse + decompress sections) →
   `ppcx analyze` (boundaries + opcode coverage, cached) →
   `ppcx imports` (REL24/ADDR16 map) → `ppcx translate` (BFS over callees,
   emits one C function per guest function) → TCC → `src/runtime`
   (flat arena, dispatcher, HLE entry points). Analysis of the whole
   module takes **~2.3 s**; nothing derived from the game is committed
   (generated C goes to the git-ignored `build/`).

2. **Boundary census.**
   - Branch-derived: **96,874 starts** (`bl` targets + prologue-after-a-
     boundary heuristic). The local Ghidra census of the same module has
     97,363; overlap is 99%+ (Ghidra-only 1,311, ours-only 822).
   - Pointer-derived: `ADDR32` relocations in `.rela.rodata` patch 138,263
     u32 values so they point into `.text`; **104,026 of those targets are
     additional function starts** no branch scan can see (vtables, callback
     tables, clusters of tiny constant getters). Sampled targets are
     4-aligned, follow a control-flow boundary (almost always `blr`) and
     disassemble as coherent functions (`li r3,N; blr` clusters, `li r3,13;
     b <merge>` fragments). Splitting ranges at such targets is harmless in
     this execution model because every register lives in one shared `Cpu`.
   - Translation ranges use the union of both sets: **200,900 starts**.

3. **Instruction coverage** (9,248,515 words): **97.00% supported**,
   2.96% known-but-unsupported, 0.04% unknown/data. The unsupported mass is
   concentrated: `psq_l` 118,005, `psq_st` 93,411, `lmw` 33,884, `stmw`
   21,568, `frsqrte` 4,538, `ps_rsqrte` 1,238, `ps_res` 686, `fres` 65,
   `tw` 135, plus a thin tail of unallocated `op31` XOs. Implementing the
   paired-single memory ops, the block moves and the estimate family lifts
   coverage above 99.9%.

4. **Import model validated on the real module.** 445 slots (437 functions,
   8 data). 16,682 REL24 sites split into **16,522 `bl` calls and 160 `b`
   tail calls** (tail modules: coreinit 99, gx2 46, snd_core 9, padscore 5,
   proc_ui 1). 40 ADDR16 address-taken sites, all coreinit (heap function
   pointers, `_iob`, callback registrations). The loader's patch mechanics
   are visible in the file: REL24 fields hold placeholders (the sampled
   site stored a branch outside `.text`), the relocation entry is the
   authoritative target; internal references are pre-linked and need no
   substitution.

5. **Decoder defects found by validating on the real module** (all now
   under regression tests):
   - `LI` was sign-extended from the wrong bit and lost its top two bytes,
     so branch targets beyond ±8 MB were wrong — in a 37 MB `.text` that is
     most `bl` targets. `BD` folded the AA/LK bits into the displacement.
   - `blr`, unconditional `bclr` and `bctr` were not wired to
     return/indirect-tail emission.
   - `b`-to-import sites (tail calls) were not substituted.

6. **End-to-end demo on real code.** `FUN_031FA4CC` — the GraphicsSystem
   method at vtable `+0x5C` per the boot-path note, found here through the
   pointer starts — materializes `0x031FA4C8` in `r3` and tail-branches to
   `proc_ui.ProcUIInit` at a REL24 site. The translator emits three C
   statements, TCC compiles the unit, and the runtime prints:

   ```
   ppcx: entry 0x031FA4CC, 1 translated function(s)
   ppcx: HLE call #1: proc_ui.ProcUIInit (import 359)
   ppcx: entry returned, r3 = 0x031FA4C8
   ```

   This exercises decode, relocation-driven HLE substitution, the tail-call
   convention, the dispatcher, the HLE name table and the TCC ABI in one
   shot — and confirms the boot-path note's reading of that method.

7. **Runtime skeleton.** One flat arena of `0xC2000000` bytes covers every
   address the module is linked for (import slots sit at `0xC0000000`);
   dispatch is a binary search over the generated registry; address-taken
   imports get pseudo-addresses at `0x50000000 + 8·idx` (a region no
   section uses: `.text` ends at `0x04347C2C`, data sections end at
   `~0x105DB1C0`); unsupported instructions and unregistered targets stop
   with an address + register dump. `PPCX_HLE_TRACE=1` logs every HLE call,
   `PPCX_HLE_STRICT=1` aborts on the first.

## Evidence quality

- **Observed:** all metrics above, produced by our tools on our own copy;
  the Ghidra census is a local comparison artifact only.
- **Derived:** the interpretation of `.rodata` ADDR32 entries as code
  pointers (validated by sampling), and the tail-call reading of
  `b`-to-import sites (decided by the relocation, not by the stored field).
- **Unknown:** whether every pointer-derived start is a true entry (the
  model tolerates false positives by design); loader/MMU details of the
  console; the exact set of addresses the game touches at runtime.

## Open questions / next steps towards a first GX2 frame

- **Data image:** load `.rodata`/`.data`/`.bss` into the arena and apply
  data relocations (table slots holding imports need `PPCX_IMPORT_ADDR`).
  Nothing that walks a table can run before this exists.
- **HLE tier 1:** coreinit (`OSGetCoreId`, `OSMemoryBarrier`,
  `OSGetSystemTime`, `OSBlockMove/Set`, `memcpy`, `_iob`,
  `__gh_FOPEN_MAX`), then proc_ui/padscore stubs.
- **GX2 bootstrap:** drive the documented chain (entry `0x03C70404` →
  `FUN_02c5e5f4` → … → `FUN_0309bbb0`, the only `GX2Init` site at
  `0x0309BC80`) with dispatch tracing, then model GX2 calls as
  log-only no-ops and count frames before attempting any real rendering.
- **Opcode gaps:** `psq_l`/`psq_st`, `lmw`/`stmw`, `fres`/`frsqrte`/
  `ps_res`/`ps_rsqrte`, `tw`.
- **Scale test:** a `--follow` stress run from the entry point to measure
  translation throughput and generated-code size for the full closure.
