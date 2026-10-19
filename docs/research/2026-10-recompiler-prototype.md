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
   (region-checked arena, dispatcher, HLE entry points). Analysis of the whole
   module takes **~3 s**; nothing derived from the game is committed
   (generated C goes to the git-ignored `build/`).

2. **Boundary census.**
   - Branch-derived: **96,874 starts** (`bl` targets + prologue-after-a-
     boundary heuristic). The local Ghidra census of the same module has
     97,363 (96,946 in `.text` plus 417 named import stubs at `0xC000xxxx`);
     the measured overlap is 96,052 starts (99.15%) and the differences are
     classified in item 11.
   - Pointer-derived: `ADDR32` relocations in `.rela.rodata` and
     `.rela.data` patch 139,005 u32 values so they point into `.text`;
     **104,499 of those targets are additional function starts** no branch
     scan can see (vtables, callback tables, static-init tables in `.data`,
     clusters of tiny constant getters). Sampled targets are 4-aligned,
     follow a control-flow boundary (almost always `blr`) and disassemble
     as coherent functions (`li r3,N; blr` clusters, `li r3,13; b <merge>`
     fragments); 91,976 of the 104,499 follow a `blr` and all but 2 a
     terminal transfer. Splitting ranges at such targets is harmless in
     this execution model because every register lives in one shared
     `Cpu`. The Ghidra census contains only 115 of these targets (it does
     not model relocation-derived entries); the 473 starts added by the
     `.data` scan (2026-10-19) are absent from it entirely.
   - Cross-range tail targets: a `b`/`bc` whose target lies outside the
     site's own translation range becomes a runtime dispatch, so the target
     must be a start. Iterating that requirement over the full partition
     (branch + pointer starts) to a fixpoint adds **518 starts** on v208 —
     360 of them are the census tail-`b` entries, the rest are entries the
     census misses. Re-checked after the fact: of all 828,267 in-text
     `b`/`bc` pairs with the final union, 20,476 target a start and 807,791
     are intra-range, with **zero remaining dispatch gaps**. The naive
     “tail target after a terminal instruction” rule matches 17,414
     candidates, 34x the exact set. Sampled targets follow a terminal
     transfer (505 of 518, 399 right after a `blr`) and disassemble as real
     entries (`lwz`, `addis`, `or`-style prologues, `addi`, `lbz`, …).
   - Translation ranges use the union of all three sets: **201,891 starts**.

3. **Instruction coverage** (9,248,515 words): **99.9994% supported**
   (9,248,462), no known-unsupported instructions, 0.0006% unknown/data
   (53: `invalid-0` 47, `op0` 6). Re-measured on 2026-10-19 after
   implementing the quantized paired-single loads/stores, the last
   known-unsupported block (`psq_l` 118,005 + `psq_st` 93,411 = 211,416
   words in this module), and again after the independent decode
   cross-check fixed the `lhzux`/`lhaux` encodings (the 11 former
   `op31-xo375` words are decoded now and 8 more functions became fully
   supported, 96,865 total). Earlier snapshots: 97.71% / 2.29% / 0.00%
   (post-audit) and 97.00% / 2.96% / 0.04% (pre-fix).

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
   - `lhzux` (XO 311) was named `lhaux` with sign extension, so every
     `lhzux` in the module (37 words) was translated as a sign-extending
     load, while `lhaux` (XO 375, 11 words) was not decoded at all. The
     independent oracle in `tests/isa` carried the same mistake, so the
     differential harness could not see it; the external rizin cross-check
     exposed it (2026-10-19). Both encodings are fixed and gated by
     differential cases, including the update order when rT = rA.

6. **End-to-end demo on real code.** `FUN_031FA4CC` — the GraphicsSystem
   method at vtable `+0x5C` per the boot-path note, found here through the
   pointer starts — materializes `0x031FA4C8` in `r3` and tail-branches to
   `proc_ui.ProcUIInit` at a REL24 site. The translator emits three C
   statements, TCC compiles the unit, and the runtime prints:

   ```
   ppcx: entry 0x031FA4CC, 1 translated function(s)
   ppcx: entry returned, r3 = 0x031FA4C8
   ppcx: HLE calls: 1 (unimplemented services remain)
   ```

   `PPCX_HLE_TRACE=1` logs the per-call line (`HLE unimplemented #1:
   proc_ui.ProcUIInit (import 359) [diagnostic no-op]`) and
   `PPCX_HLE_STRICT=1` stops there with the register dump and exit code 5;
   13 coreinit identity and memory/cache calls are modeled and `ProcUIInit`
   is not one of them. This exercises decode, relocation-driven HLE
   substitution, the tail-call convention, the dispatcher, the HLE name
   table and the TCC ABI in one shot — and confirms the boot-path note's
   reading of that method.

7. **Runtime skeleton.** One flat arena of `0xC2000000` bytes covers every
   address the module is linked for (import slots sit at `0xC0000000`);
   dispatch is a binary search over the generated registry; address-taken
   imports get pseudo-addresses at `0x50000000 + 8·idx` (a region no
   section uses: `.text` ends at `0x04347C2C`, data sections end at
   `~0x105DB1C0`); unsupported instructions and unregistered targets stop
   with an address + register dump. `PPCX_HLE_TRACE=1` logs every HLE call,
   `PPCX_HLE_STRICT=1` aborts on the first unimplemented one (exit code 5);
   13 coreinit identity and memory/cache calls are modeled and stay
   available.

8. **Audit correction pass (2026-10-18).** An independent source audit fixed
   thirteen semantic defects in the runtime ABI, the decoder and the
   translator (PPC-001…PPC-013: rotate mask, `lswi`/`stswi` group advance,
   `bcl` link handling, CR0 only on Rc, `mulli` sign, `cmpli`
   zero-extension, r0-as-literal in `addic`/`subfic`/`cmpi`/`cmpli`,
   `lwsync` codegen, `neg` carry, OE=1 decoding, divide edge cases, OE
   operand aliasing, `nego` overflow). Verification: 185 compiled synthetic
   programs compared against an independent oracle (221 today, including the
   paired-single cases below), every fix re-introduced as a mutation and
   caught (10/10), 94 automated tests green at the time (102 today), and the
   coverage table above re-measured. v208 itself contains no OE=1
   instruction, no `bcl` with LK and no `lwsync`, so those defects were
   latent in this title; the rotate-mask fix still affects 194,957
   instructions the module executes. See
   [the audit](../audits/2026-10-18-code-audit.md).

9. **Quantized paired-single load/store (2026-10-19).** The last
   known-unsupported block is implemented: `psq_l`/`psq_lu`/`psq_st`/
   `psq_stu` and the indexed `psq_lx`/`psq_stx`/`psq_lux`/`psq_stux` decode,
   translate and execute. GQR0–7 (SPR 912–919) and HID2 (SPR 920, `LSQE`)
   are part of `Cpu`; loads dequantize with `2^-scale`, stores quantize with
   `2^scale`, clamp to the type range and truncate toward zero, and float
   stores follow the reference flush-to-zero rule for single-subnormal
   results. Since v208 never writes HID2 or the GQRs but executes 211,416
   `psq_*` instructions, the model boots with `LSQE=1` and all-zero GQRs
   (float quantization) — a documented assumption, not an observation.
   The differential harness grew to 226 compiled programs / 927 state
   lines (the 2026-10-19 cross-check added `lhzx`/`lhzux`/`lhax`/`lhaux`
   cases, including the rT = rA update order): it now compares raw-bit FPR
   lanes plus the GQR/HID2 state on every case and includes 36 new
   paired-single cases (all quantize types, both scale signs, paired and
   unpaired `W` forms, indexed addressing, update forms, clamping,
   truncation and FTZ corners). See
   [the audit](../audits/2026-10-18-code-audit.md).

   The compiled loader harness (`tests/loader`) covers the load image the
   same way: a synthetic RPX with relocated `.rodata`/`.data`, zero-filled
   `.bss`, ten corrupted-blob classes (bad magic/count/table size, empty
   segment, unknown flags, arena escape, overlap, payload escape, checksum)
   and Fletcher-32 boundary probes; `node tests/loader/run.js` →
   `loader: 62 state lines, 10 negative blobs, read-only write fault … loader: OK`.

   The synthetic boot fixture (`tests/boot`) closes the loop from authored
   RPX bytes to a booted guest. It builds a game-free RPX (seven functions,
   three imports — one called directly through a REL24 site, one reached
   through an ADDR16 trampoline, one unmodeled — three relocated `.rodata`
   pointers with one addend, two deferred TLS sites, `.data`/`.bss` and the
   allocated metadata trio), runs the real `analyze` → `translateModule` →
   `buildImage` pipeline and compiles the result with the real runtime,
   checked-memory model and HLE layer. Seven scenarios compare every
   stderr/stdout line: a boot with `PPCX_HLE_TRACE`/`PPCX_DISPATCH_TRACE`
   checkpoints, an unmodeled import tolerated as a counted no-op, strict mode
   (exit 5 + register dump), a pointer-only getter, a cross-range tail `b`
   that runs a mid-body entry point discovered by the analysis (it lands
   after `addi r3,0,0x40`, so the expected `r3 = 2` proves the entry point;
   entering the split function from its top would leave `0x42`), a read
   outside every region (exit 9) and the same boot without `PPCX_IMAGE`
   (fault at the first data read instead of zeroes); guest probes assert the
   applied relocations, the untouched TLS bytes and the two copied words in
   `.data`/`.bss`, and the boot run must repeat byte-identically.
   `node tests/boot/run.js` → `boot: 7 scenarios (5 entries compiled), 33
   transcript lines, 48 memory probe lines … boot: OK, the synthetic RPX
   boots headless with stable checkpoints` (TCC 0.9.27, 2026-10-19).

   The fixture paid for itself immediately by finding two real defects. (1)
   Address-taken imports were absent from the generated `ppcx_import_name`
   table — the translator only recorded REL24 call sites — so the dispatcher
   reported `unknown-import` and the HLE layer silently no-opped a call made
   through the trampoline; `translateFunction` now reports `importAddrs` (one
   entry per import, not per HA/LO site), `translateModule` unions those with
   the REL24 imports for the name table, and the report gains
   `importAddrs`/`addressTaken`. (2) The initial guest SP sat exactly at the
   top of the mapped stack, leaving the loader's ABI frame outside the
   region, so any translated function with the standard prologue
   (`stwu r1,-N(r1)` + LR save at `SP+4` of the caller frame) faulted at its
   LR store; `ppcx_run` now starts at `PPCX_INITIAL_STACK - 16`, inside the
   mapped stack and 16-byte aligned. Both were observed as failing
   transcripts before the fixes (10 and 4 reported failures in the two
   mutation runs — reverting the frame and changing one authored data word);
   the v208 demo afterwards is unchanged (`r3 = 0x031FA4C8`,
   `proc_ui.ProcUIInit` still reported, strict exit 5). The cross-range tail
   start has its own mutation gate: with the analyzer from before the
   fixpoint, the same fixture reports 14 failing expectations, including the
   real runtime `branch or call to an address with no registered function
   (0x000100F0)` followed by exit 4 — the exact failure mode the analysis
   fixpoint removes.

10. **Independent decode cross-check (2026-10-19).** The whole decompressed
    `.text` was disassembled with rizin through REA (`asm.arch=ppc`,
    `asm.bits=32`, `asm.cpu=ps`, `io.va=false`, 36 chunks of 262,144 words)
    and compared word by word with the decoder through the new
    `tools/ppcx/xcheck.js`. Result over all 9,248,515 words: 5,843,694 with
    identical canonical mnemonics (63.1852%), 3,404,768 differing only by a
    documented assembler alias (36.8142% — `mr`/`or`, `li`/`addi`,
    `slwi`/`rlwinm`, `btlr`/`bclr`, `subc`/`subfc`, `trap`/`twu`/`tw`),
    **zero real disagreements**, and the same 53 data/illegal words
    rejected by both sides. The 31 alias classes observed were reviewed one
    by one and are all standard extended mnemonics. The check found the
    `lhzux`/`lhaux` defect above; it also verified that rizin's
    `asm.cpu=ps` model decodes the paired-single encodings this target
    executes without the VSX ambiguity seen under the default CPU. The dump
    is game-derived and stays under `build/`; the comparison tool and the
    rizin recipe are in the repository, and the check is intentionally not
    part of CI because it needs an external disassembler.

11. **Function-start cross-check against the local Ghidra census
    (2026-10-19).** The branch-derived starts (96,874) and the pointer
    starts (104,499 extra; 201,891 translation ranges with the tail starts)
    were compared with the Ghidra 12.1 headless census of the same module
    (97,363 functions: 96,946 in `.text` plus 417 named import stubs at
    `0xC000xxxx`). **96,052 branch starts agree (99.15%)**, and the
    pointer class is almost entirely absent from the census (115 of
    104,499). The 779 Ghidra-only in-`.text` entries split into 362
    targets of tail `b` branches (473 sites, no `bl` site — our
    branch-derived discovery deliberately skips tail targets unless they
    look like a prologue after a boundary; the cross-range tail-start
    class below covers the ones a `b` from another range needs) and 417
    others: tiny leaves after boundaries that no
    prologue shape matches (`addi r3,r3,8; blr`, `li r3,1; blr`),
    large-frame prologues that begin `mr r11,r1; stwu …` before the
    `mflr`, and a dense cluster of 8-byte non-prologue entries around
    `0x04004xxx`–`0x04005xxx` whose entry words decode as paired-single
    math (`psq_l`/`psq_st`/`ps_merge01`) — Ghidra fragments or genuinely
    tiny functions is unresolved. The 822 ours-only branch starts (498
    `bl` targets, 324 prologues after a boundary) have no census function
    covering them at all; sampled `bl` sites are real calls in the rizin
    dump and Ghidra has multi-kilobyte gaps there (e.g. no function
    between `0x04232C18` and `0x042335F4`), so the census is a lower
    bound, not a completeness reference. The pointer-only targets are
    tiny constant getters (`li r3,N; blr`), no-op stubs and trampolines
    (`addi r3,r3,-N; b`): 91,976 of 104,499 follow a `blr` and all but 2
    follow a terminal transfer. The tail-target gap was closed on
    2026-10-19 with the cross-range fixpoint (item 2): **518 starts added,
    360 of the 362 census tail-`b` entries covered**, and an
    after-the-fact re-check of all 828,267 in-text `b`/`bc` pairs against
    the final union leaves **zero dispatch gaps** (20,476 pairs target a
    start, 807,791 are intra-range). The 2 uncovered census entries
    (`0x0400547C`, `0x0420D92C`) are intra-range `goto`s in our partition,
    so no entry is needed. The naive “tail target after a terminal
    instruction” rule would have added 17,414 starts (34x the exact set).
    The `.rela.data` gap was closed on
    2026-10-19: the pointer scan now reads `.rela.data` as well (+473
    extra starts, +742 total targets; union 200,900 → 201,373 before the
    tail fixpoint above). The comparison used the
    local census CSV under `Tools/analysis/` and the analysis JSON; both
    are game-derived and stay ignored.

## Evidence quality

- **Observed:** all metrics above, produced by our tools on our own copy
  (coverage re-measured 2026-10-19 after the paired-single implementation;
  the 2026-10-18 audit checkpoint read 97.71%); the loader-image metrics
  (31 segments, 43,155,811 bytes, 278,749 applied relocations, 6 deferred
  TLS sites) come from an `image` run pinned to the recorded v208 SHA-256;
  the Ghidra census is a local comparison artifact only.
- **Derived:** the interpretation of `.rodata` ADDR32 entries as code
  pointers (validated by sampling), and the tail-call reading of
  `b`-to-import sites (decided by the relocation, not by the stored field).
- **Unknown:** whether every pointer-derived or cross-range tail start is a
  true entry (the model tolerates false positives by design); loader/MMU
  details of the
  console; the exact set of addresses the game touches at runtime.

## Open questions / next steps towards a first GX2 frame

- **Data image:** implemented 2026-10-19 — `tools/ppcx image` validates and
  serializes every allocated section of the module (31 sections,
  43,155,811 bytes including the 1,399,469-byte `.bss`), applies the 278,749
  `R_PPC_ADDR32` data relocations, leaves the 889,935 executable-section
  relocations to the recompiler and defers the 6 TLS sites explicitly; the
  runtime maps the blob with bounds/order/checksum checks
  (`src/runtime/src/ppcx_image.c`). Data slots that point into import slots
  are not observed in v208 and stay unmodelled. What remains for this item
  is the *code* that walks the loaded tables (HLE tier 1 below), not the
  image itself.
- **Checked guest memory:** implemented 2026-10-19 (RUN-003) — `ppcx_run`
  installs a region map (1 MiB of stack plus every loaded segment) and all
  guest accessors require an access to fall entirely inside one region;
  anything else prints one deterministic diagnostic plus the register
  context and exits with code 9 (`src/runtime/src/ppcx_mem.c`; compiled
  harness in `tests/mem`, checked probes of the relocated synthetic image
  in `tests/loader`). Permissions are derived from the ELF section flags in
  the blob: on v208, 5 segments are writable (`.rodata`, `.data`,
  `.module_id`, `.bss`, `.thrbss`; 6,140,245 bytes) and 26 read-only
  (`.text`, `.syscall`, the import tables and the allocated metadata;
  37,015,566 bytes); a write to a read-only region faults with its own
  deterministic diagnostic and exit code 9. The same compiled harness now
  links the HLE memory/cache models and checks their range validation under
  that map. Executable permission is not
  enforced because translated code is native C and never fetches guest
  bytes. The next evidence to gather is a translated data-reading function
  running against the real image, so that any unmodelled address (heap,
  MMIO, import trampolines) faults loudly instead of returning zeroes.
- **HLE tier 1:** the mechanical subset landed 2026-10-19 in
  `src/runtime/src/ppcx_hle.c` — the four core-identity calls plus nine
  flat-memory/cache primitives (`OSBlockMove` 6,834 REL24 sites + 2,
  `memcpy` 408 + 2, `OSMemoryBarrier` 330 + 2, `OSBlockSet` 295 + 2,
  `DCZeroRange` 119, `DCFlushRange` 77, `DCFlushRangeNoSync` 29,
  `DCInvalidateRange` 9, `memset` 84). Each memory model validates its whole
  range against the checked region map before touching memory (no partial
  effects; exit code 9 on a read-only or unmapped target) and `OSBlockMove`
  implements the documented overlap explicitly, because the local TCC's
  `memmove` was measured to copy forward and corrupt an overlapping
  destination (2026-10-19). Remaining tier 1 work: `OSGetSystemTime` /
  `OSGetTime` (491 sites, clock semantics still to define), TLS
  (`__tls_get_addr`, 3,371 sites) and the `_iob` / `__gh_FOPEN_MAX` data
  slots; then proc_ui/padscore stubs.
- **GX2 bootstrap:** drive the documented chain (entry `0x03C70404` →
  `FUN_02c5e5f4` → … → `FUN_0309bbb0`, the only `GX2Init` site at
  `0x0309BC80`) with dispatch tracing, then model GX2 calls as
  log-only no-ops and count frames before attempting any real rendering.
- **Opcode gaps:** none left that the game executes. The remaining 53
  unknown/data words (47 zero words, 6 `op0`) need a manual review for
  false decodes or embedded data; the external cross-check independently
  reports `invalid` for the same words.
- **Scale test:** a `--follow` stress run from the entry point to measure
  translation throughput and generated-code size for the full closure.
