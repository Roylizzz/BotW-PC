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
| SHA-256 (v208, local) | `ba58da5b95ce929e005d058ceb08b9b2788d1ab2bbc8a6c189bbadca0bb34d30` (pins our own copy; the file itself never leaves the workstation) |
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
| [REA](https://github.com/morluto/rea) | 6.5.0 | ✅ MCP server connects (agent config launches absolute `node.exe` + `rea-agents/scripts/rea.mjs`; no `npx` in the loop) |
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

In this workspace the project is `BotWPC` and the imported program is
`U-King-v208.rpx`; the read-only `ListSummary` + `ExportFunctions` pass was
re-run on 2026-10-18 with `MAXMEM=3G` and exported 97,365 functions.

The helpers in [`tools/ghidra-scripts/`](../../tools/ghidra-scripts/) are
generic (no game data): `ListSummary`, `ExportFunctions`,
`DecompileMatch`, and `TuneAnalysis` (option tuning for headless runs).
Decompiler output and project databases stay local — never commit them.


## Platform constraints (important)

- **Measured on 2026-10-18** (v208, `U-King-v208.rpx`): REA accepts the
  file's *identity* (`open_binary` → `format: "elf"`,
  `architecture: "powerpc"`) but **every deep-analysis candidate provider
  refuses it**: `ghidra` → `target_format_unsupported` ("Windows Ghidra P0
  accepts native PE and explicitly selected raw 6502 targets only"),
  `hopper` → `unsupported_host` + `architecture_unsupported`, `ida` →
  `not_configured` + `architecture_unsupported`. There is no REA path to
  deep analysis of the RPX on this workstation, and no Linux/macOS host is
  available (WSL is not installed).
- **The working path is direct Ghidra 12.1.4 headless** (PowerPC support is
  in core Ghidra, no REA involved): a read-only pass on the local project
  `BotWPC` opened `U-King-v208.rpx` as
  `PowerPC:BE:32:Gekko_Broadway_Espresso`, `.text` =
  `0x02000020`–`0x04347C2B`, and exported **97,365 functions** (CSV kept
  locally under the git-ignored `build/audit/`). See the recipe above.
- Stock rizin/objdump cannot consume the RPX directly (see the target
  notes); `tools/rpxinfo` handles the structure and zlib sections locally.
  REA remains useful for targets its providers do admit (PE/ELF x86 family,
  archives, JavaScript, evidence-oriented capture).

## Working rules

- Scratch/patched copies of executables live under a local tools folder
  (e.g. `Tools/analysis/`), never in this repository.
- Analysis databases (Ghidra projects) stay local.
- Findings are written up in `docs/research/` as descriptions only.
