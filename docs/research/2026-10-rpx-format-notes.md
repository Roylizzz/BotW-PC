# RPX format: first verified notes

- **Date:** 2026-10-18
- **Game version:** Wii U (update v208 used for verification)
- **Tooling:** `tools/rpxinfo` (original), local hex inspection, zlib checks
- **Contributor:** @Roylizzz
- **Source:** own copy, analyzed locally

## Question

What is `code/U-King.rpx`, and how do we load it into analysis tools?

## Findings

1. **Modified ELF32 big-endian object**: `EM_PPC` (PowerPC, 20), custom
   `e_type 0xFE01`, **no program headers**; 37 section headers at file
   offset 64 (40 bytes each); entry `0x03C70404` (update v208).
2. **Sections flagged `0x08000000` are zlib-compressed**, layout:
   `u32be uncompressed size` + zlib stream. Verified on every flagged
   section (24/24 inflated cleanly, size prefixes match exactly).
   - `.text`: ~16.5 MB stored → **36,994,060 bytes** (≈ 35.3 MiB), at
     vaddr `0x02000020`, first instructions are a standard PowerPC prologue.
   - `.rodata` → 4,598,716 bytes; `.rela.text` → 10,679,220 bytes.
   - The section-name string table is compressed too (461 bytes).
3. **Section inventory** (names now readable):
   - Code/data: `.syscall` (8-byte stub), `.text`, `.rodata`, `.data`,
     `.module_id`, `.bss`, `.thrbss` (thread-local), `.rela.text`,
     `.rela.rodata`, `.rela.data`.
   - Symbols: `.symtab` (7,728 bytes) and `.strtab` (9,525 bytes
     decompressed) — worth inspecting for usable names.
   - **System-library imports** (fimport/dimport stubs): `gx2` (graphics),
     `snd_core`, `snd_user` (audio), `h264` (video), `nn_save`, `vpad`,
     `vpadbase`, `proc_ui`, `padscore`, `coreinit`, `sysapp`, `zlib125`,
     `nn_act`, `nn_boss`, `nn_aoc`, `nn_nfp`, `nsysnet`, `nn_ac`.
   - Two unnamed metadata sections: types `0x80000003` (148 bytes) and
     `0x80000004` (221 bytes).
4. **Address space regions observed:** `0x02000000` (code),
   `0x10000000` (data), `0xC0000000` (imports, symbols, metadata).
5. **Porting implication:** the binary expects the whole Cafe OS runtime
   (GX2 graphics, audio, video, save, proc, NFC, network…). Any PC runtime
   must supply equivalents — the same problem an emulator solves with
   high-level emulation. This shapes the Phase 2 architecture decision.

## Evidence quality

- **Observed** (locally reproducible with `tools/rpxinfo`): header facts,
  compression layout, sizes, section names.
- **Sourced** (public): WiiUBrew `RPL` page confirms the format traits
  (modified ELF, zlib sections, no program headers, import/export tables).

## Open questions

- Semantics of section types `0x80000003` / `0x80000004`.
- Symbol coverage of `.symtab`/`.strtab`.
- Reconstructing a full load image (section layout + relocations) for
  analysis is the next milestone.
