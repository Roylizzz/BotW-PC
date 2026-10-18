# Ghidra census: first full analysis of the v208 executable

- **Date:** 2026-10-18
- **Game version:** Wii U update v208 (`code/U-King.rpx`)
- **Tooling:** Ghidra 12.1.4 (headless, 3 GiB JVM heap) +
  [Maschell/GhidraRPXLoader](https://github.com/Maschell/GhidraRPXLoader)
- **Contributor:** @Roylizzz
- **Source:** own copy, analyzed locally

## Question

What does a default full auto-analysis of the 35 MiB PowerPC executable
produce, how long does it take on modest hardware, and how usable is the
result for Phase 2 planning?

## Findings

1. **Loader**: the RPX is auto-detected (no forced loader needed) and
   analyzed as `PowerPC:BE:32:Gekko_Broadway_Espresso`. All 37 ELF
   sections are mapped with the expected layout — code at `0x02000000`,
   data at `0x10000000`, imports/symbols at `0xC0000000` — plus synthetic
   blocks for the ELF header, section headers and external references.
2. **Import naming works**: the loader applies `.symtab` names and
   creates import slots with an 8-byte stride starting at `0xC0004540`.
   Named entries include C APIs (`GX2BeginDisplayListEx`, `OSBlockMove`,
   …) and C++-mangled Wii U SDK symbols (e.g. `nn::nfp::MountRom`,
   `nn::nfp::StartDetection`). **1,024 functions carry a name**: 600
   `thunk_*` wrappers, 125 `GX2*` imports, 50 C++-mangled SDK names,
   plus analyzer-generated `caseD_*` labels and other import names.
3. **Auto-analysis cost**: **1,427 s (~24 min)** on a 2-vCPU / 7.7 GiB
   VM with a 3 GiB heap. Slowest analyzers: Stack 430 s, PowerPC
   Constant Reference 355 s, Decompiler Switch Analysis 303 s,
   Disassemble 167 s.
4. **Database size**: **97,363 functions** (median 144 bytes; 9,306 are
   ≤ 16 bytes, 20,507 ≤ 64 bytes) and 734,177 symbols. The tiny-function
   tail mixes real small accessors with analyzer false positives and
   needs triage before any code-generation work.
5. **Entry point**: `0x03C70404` becomes `FUN_03c70404` (404 bytes) and
   decompiles cleanly without hand fixes: it initializes C++ exception
   pointers, calls a candidate `main(argc, argv)`, then checks the
   loader magic `0xDEADF00D` before teardown.
6. **Import slots are zero-filled placeholders**: `.fimport_gx2`
   decompresses to 1,040 all-zero bytes (stored compressed in 31 bytes).
   The slots are marked executable; the console loader presumably
   patches absolute branches or addresses into them at load time (exact
   patch format unknown). On PC, an HLE layer has to provide them.
7. **The relocation table enumerates the API call surface**:
   `.rela.text` holds **889,935 relocations** against only **448
   distinct symbols**:
   - types: `R_PPC_ADDR16_LO` 447,617; `R_PPC_ADDR16_HA` 425,613;
     `R_PPC_REL24` 16,690; `R_PPC_ADDR16_HI` 15;
   - the pseudo-symbols `$DATA` (847,666) and `$TEXT` (25,533) account
     for most entries (position-independent base addressing);
   - most-relocated imports: `OSBlockMove` 6,836, `__tls_get_addr`
     3,371, `OSGetCoreId` 1,380, `OSGetSystemTime` 483, `memcpy` 410,
     `OSMemoryBarrier` 332, `GX2SetPixelUniformBlock` 240, …;
   - all 129 GX2 imports are referenced. The table is effectively a
     call-site index for system APIs.

## Evidence quality

- **Observed:** memory layout, symbol application, timing, function and
  relocation counts, zero-filled import slots, entry decompilation.
- **Derived:** the "call-site index" framing follows from the relocation
  types and the small set of target symbols.
- **Unknown:** how many of the 97k functions are analyzer artifacts; the
  real module boundaries inside `.text`.

## Open questions

- Are import calls patched via the `.rela.text` entries, a separate
  loader table, or both? `R_PPC_REL24` entries against import symbols
  suggest direct branches for calls.
- Which functions form the C++ runtime vs. the game itself? The
  `0x0400xxxx` area (near the end of `.text`) looks like support code
  (entry, main, allocator glue).
- Three `fimport` sections (`snd_user`, `nsysnet`, `nn_ac`) still expose
  no per-function symbols — how are those imports called?
