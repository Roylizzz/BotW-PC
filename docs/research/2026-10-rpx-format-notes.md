# RPX format: first verified notes

- **Date:** 2026-10-18
- **Game version:** Wii U (update v208 used for verification)
- **Tooling:** `tools/rpxinfo` (original), local hex inspection, zlib checks,
  Ghidra 12.1.4 + RPX/RPL loader
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
     decompressed) — inspected; see *Symbol table* below.
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

## Symbol table (verified)

- `.symtab` uses the standard 16-byte `Elf32_Sym` layout: 483 entries,
  437 of them `FUNC` symbols (verified with `tools/rpxinfo symbols`).
- The binary publishes its **system-library imports with full names**
  (18 `fimport_*` sections, 8-byte stubs starting at `0xC0004540`;
  addresses step by 8, e.g. `0xC0004548`, `0xC0004550`, …).
  Function imports per library: `gx2` 129, `coreinit` 141,
  `snd_core` 61, `nn_nfp` 19, `nn_boss` 17, `h264` 13, `padscore` 12,
  `vpad` 10, `nn_save` 9, `nn_aoc` 7, `zlib125` 6, `proc_ui` 5,
  `sysapp` 4, `nn_act` 3, `vpadbase` 1 — 437 in total. Each
  `fimport_*` section also carries one `SECTION` symbol of the same name
  (counting those explains the "+1" per library).
- **Data imports** live in `dimport` sections referencing pointers:
  `.dimport_coreinit` (9 entries), `.dimport_nn_boss` (2),
  `.dimport_nn_act` (2).
- `snd_user`, `nsysnet` and `nn_ac` sections exist but expose only their
  `SECTION` symbol — no named functions in `.symtab` (open question).
- Exported data symbols include **Havok TLS globals** in `.thrbss`
  (`hkThreadNumber`, `s_memoryRouter`, `hkMonitorStream` instance) —
  the game ships with Havok physics.
- `.text` contains **no internal function names** (stripped): internal
  function identification is our own work from here on.

## Evidence quality

- **Observed** (locally reproducible with `tools/rpxinfo`): header facts,
  compression layout, sizes, section names, symbol table contents.
- **Sourced** (public): WiiUBrew `RPL` page confirms the format traits
  (modified ELF, zlib sections, no program headers, import/export tables).

## Open questions

- Semantics of section types `0x80000003` / `0x80000004`.
- Reconstructing a full load image (section layout + relocations) for
  analysis is the next milestone.
