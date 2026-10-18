# Analysis environment

Status of the reverse-engineering toolchain and the analysis target.
Everything here happens **locally**; nothing from a game copy ever enters
this repository.

## Target facts (Wii U release)

| Fact | Value |
| ---- | ----- |
| Main executable | `code/U-King.rpx` (base) and the update's `U-King.rpx` |
| Format | ELF32, big-endian, `EM_PPC` (PowerPC #20), custom `e_type=0xFE01` (RPX) |
| Entry point | base `0x03AB62AC` / update v208 `0x03C70404` |
| Sizes | base ≈ 21.0 MB / update v208 ≈ 22.2 MB |
| Updates | v208 is the latest published update (the version upstream research commonly calls 1.5.0) |

Notes for tooling:

- The file is an ELF variant with **zlib-compressed sections** and **no
  program headers**. Stock ELF loaders (rizin, objdump, stock Ghidra)
  cannot consume it directly. Use the community Ghidra RPX/RPL loader
  extension ([Maschell/GhidraRPXLoader](https://github.com/Maschell/GhidraRPXLoader)),
  or our `tools/rpxinfo` to inspect and decompress sections locally
  (scratch files stay off-repo).
- `content/` follows the usual resource layout (`Actor/`, `Map/`, `Model/`,
  `Pack/`, `System/`, …). Format documentation is public (ZeldaMods wiki and
  community notes); we cite public documentation, not game content.

## Toolchain status (workstation, Windows x64)

| Component | Version | State |
| --------- | ------- | ----- |
| Node.js | 24.20.0 | ✅ (REA requires 22.19+/24.11+/26+) |
| JDK (Temurin) | 21 | ✅ (Ghidra 12.1.x requires 21+) |
| [REA](https://github.com/morluto/rea) | 6.5.0 (npx) | ✅ CLI works |
| [Rizin](https://rizin.re/) | 0.9.1 | ✅ (multi-arch static disassembly) |
| [Ghidra](https://ghidra-sre.org/) | 12.1.4 | ✅ installed locally + RPX/RPL loader extension (`CafeLoader`) |

## Headless analysis recipe (reproducible)

With the RPX/RPL loader installed, Ghidra detects the format by itself —
do **not** pass `-loader`. A full pass over the 35 MiB `.text` took
**~24 min** (1,427 s) on the 2-vCPU reference machine with a 3 GiB JVM
heap; results are summarized in
[`../research/2026-10-ghidra-census.md`](../research/2026-10-ghidra-census.md).

```bash
# quick look, no Ghidra needed
node tools/rpxinfo/rpxinfo.js info    <your-copy>/code/U-King.rpx
node tools/rpxinfo/rpxinfo.js symbols <your-copy>/code/U-King.rpx --func --limit 20

# import + full auto-analysis, then a one-page summary
analyzeHeadless <your-projects-dir> BotW \
  -import <your-copy>/code/U-King.rpx \
  -scriptPath tools/ghidra-scripts \
  -postScript ListSummary.java

# one-time fix after import: make the loader's imported references primary
# (ships with the RPX loader extension; without it, calls into Cafe OS
# decompile against placeholder addresses such as FUN_04004668)
analyzeHeadless <your-projects-dir> BotW -process U-King.rpx -noanalysis \
  -postScript fix_primary_imports.java

# decompile an address even when the auto-analysis did not create the
# function there: DecompileAt creates it on the fly (writable program)
analyzeHeadless <your-projects-dir> BotW -process U-King.rpx -noanalysis \
  -postScript DecompileAt.java out.c 0xADDR [0xADDR ...]

# later: read-only passes on the analyzed program
analyzeHeadless <your-projects-dir> BotW -process U-King.rpx -noanalysis -readOnly \
  -scriptPath tools/ghidra-scripts \
  -postScript ExportFunctions.java functions.csv
analyzeHeadless <your-projects-dir> BotW -process U-King.rpx -noanalysis -readOnly \
  -scriptPath tools/ghidra-scripts \
  -postScript DecompileMatch.java 0x03C70404 entry.c
```

The helpers in [`tools/ghidra-scripts/`](../../tools/ghidra-scripts/) are
generic (no game data): `ListSummary`, `ExportFunctions`,
`DecompileMatch`, and `TuneAnalysis` (option tuning for headless runs).
Decompiler output and project databases stay local — never commit them.


## Platform constraints (important)

- REA's **Ghidra provider on Windows is an experimental read-only "P0"
  boundary limited to PE x86/x86-64 targets** — it does not admit our
  PowerPC RPX.
- REA's **PowerPC lane (ELF32 BE, `EM_PPC`) requires a Linux or macOS
  host** with Ghidra. On Windows, deep PPC pseudocode analysis therefore
  uses one of:
  1. **Rizin via REA** (`execute-rizin-command`) — cross-platform static
     disassembly, works today;
  2. **Ghidra headless directly** (PowerPC support is in core Ghidra) with
     our own import scripts;
  3. a Linux/macOS workstation (not available on this machine; WSL is not
     installed).
- This is a REA limitation, not a Ghidra one: Ghidra itself analyzes
  PowerPC on Windows without issue when driven directly.

## Working rules

- Scratch/patched copies of executables live under a local tools folder
  (e.g. `Tools/analysis/`), never in this repository.
- Analysis databases (Ghidra projects) stay local.
- Findings are written up in `docs/research/` as descriptions only.
