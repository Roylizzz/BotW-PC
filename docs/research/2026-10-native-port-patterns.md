# Native PC game ports: engineering patterns and BotW-PC applicability

- Reviewed: 2026-10-18.
- Status: comparative engineering research. The evidence below describes the referenced projects; it does not demonstrate that BotW-PC already boots, renders, or is playable.
- Principle: original MIT code in this repository; no Nintendo code, dumped binaries, assets, keys or locally generated recompilations may be committed.

## What successful ports actually build

Static recompilation translates guest machine code into host-compilable C/C++ ahead of time, but a playable port ALSO requires a compatible guest memory image, imported operating-system services, threading, graphics/shaders, audio, input, storage and reliable build/test/packaging. Decompilation-based ports share the latter requirements, but rebuild from recovered source instead of machine-code translation.

## Comparison matrix

| Project (official upstream) | Actual approach | What BotW-PC should adopt | Cautions |
| --- | --- | --- | --- |
| [ZeldaWWHDRecomp](https://github.com/ZeldaWWHDRecomp/ZeldaWWHDRecomp/blob/main/docs/how-it-works.md) | Wii U PowerPC -> C -> host ARM64; original Cafe OS runtime, modeled per-core scheduling; GX2 calls mapped to native Metal with shader translation and guest texture write-watch | Split CPU, system runtime, graphics, shaders and threading into verifiable subsystems. Model OS scheduling instead of allowing arbitrary host-thread execution | Game-specific, renderer details are Metal-oriented; third-party Cemu-derived files have MPL-2.0 obligations |
| [nWiiURecomp](https://github.com/BlackLineInteractive/nWiiURecomp/blob/main/README.md) | Wii U RPX analyzer and Ghidra metadata exporter, reproducible target profiles with SHA-256, PowerPC-to-C++ translation shards, checked runtime and interpreter/differential mode | Best direct blueprint for RPX loader, relocations, sharded output, per-build manifests, interpreter oracle and no-op rejection | The README describes WWHD as its validated title, not BotW; GPL-3.0, design reference only |
| [NWiiRecomp](https://github.com/BlackLineInteractive/NWiiRecomp/blob/master/README.md) | Wii/GameCube DOL analysis, PPC translation incl. paired-single GQR handling and mid-function dispatch, HLE + interpreter fallback | Differential ISA tests for GQR/paired-single/indirect control flow and headless traces | Not Wii U RPX/Cafe OS; GPL-3.0 |
| [N64Recomp](https://github.com/N64Recomp/N64Recomp/blob/main/README.md) / [Zelda64Recomp](https://github.com/Zelda64Recomp/Zelda64Recomp) | Metadata-guided ahead-of-time recompilation of MIPS; relocations, patch overlays and specialized graphics runtime | Emit deterministic manifests, modular C, cache-aware patch builds and documented hooks | MIPS and RT64 graphics cannot be assumed portable to PowerPC/GX2; tool/runtime licenses differ |
| [Unleashed Recompiled](https://github.com/hedge-dev/UnleashedRecomp/blob/main/README.md) | Xbox 360 PowerPC via XenonRecomp; shaders via XenosRecomp, separate host kernel/graphics/audio and CMake builds | Keep CPU and shader translation separate, with independent validation and reproducible dependencies | Xbox 360 kernel and GPU differ; GPL-3.0 |
| [XenonRecomp](https://github.com/dxavsoul/xenonrecomp/blob/main/README.md) | PowerPC recompilation and runnable instruction tests against a reference test set | Compile and execute generated C in CI, compare machine state—not only generated source text | Confirm Espresso-specific differences; do not blindly reuse Xbox 360 semantics |
| [Ship of Harkinian](https://github.com/HarbourMasters/Shipwright/blob/develop/README.md) | Matching-decompilation-based port using libultraship, ROM fingerprint checks and user-local asset extraction | Validate supported image versions and package without distributing original assets | Different implementation strategy; not an AOT recompilation |
| [REA](https://github.com/morluto/rea) | Evidence-oriented reverse-engineering CLI/MCP integrating admitted native analysis providers | Evidence provenance, hypothesis tracking, reproducible analysis and agent workflow | REA is not a native Wii U port generator |

## Decisions recommended for BotW-PC

1. Keep accepted ADR-0002: static PowerPC-to-C with an original Cafe OS HLE runtime and gradual subsystem upgrades, rather than an emulator wrapper.
2. Make binary identity mandatory: own-image SHA-256 plus build, version, entry point, section map and target manifest. Never confuse identical sizes with identical content.
3. Introduce explicit intermediate artifacts: parser output, checked guest memory image, relocations/import table, function/CFG metadata, translation report, generated C shards and build manifest.
4. Validate instructions by execution: GPR, CR, LR, CTR, XER, FPR raw bits, memory writes, exception conditions and (once implemented) FPSCR. ISA decoder coverage is NOT behavioral compatibility.
5. Add an independently checked interpreter/reference as an oracle; if used at runtime for a fallback, all licensing and correctness requirements still apply.
6. Replace silent HLE placeholders with a typed implementation registry and strict statuses: implemented, explicit documented stub, unsupported. Make early boot headless and diagnostic.
7. Have distinct CPU, loader, HLE, scheduler, GPU, audio and content milestones. Reach initial GX2 command logging BEFORE implementing a full renderer.
8. Avoid one giant generated C compilation unit at scale: deterministic sharding, function registry, caches keyed by digest/tool config, incremental building.
9. Test synthetic fixtures in public CI; keep actual v208 game input and all outputs derived from it local and gitignored.
10. Record legal/credit obligations per dependency. Architecture ideas are references; GPL code must not be silently copied into an MIT project.

## Why REA is complementary, not the Wii U binary loader

As of this review, REA Windows Ghidra P0's documented admission targets native PE and certain specifically enabled experimental raw formats. Wii U big-endian PowerPC RPX is NOT one of them. Continue using direct Ghidra 12.1.x headless, the RPX/RPL loader extension, our Ghidra helper scripts, and rpxinfo/ppcx on Windows. Use REA for targets its provider explicitly accepts and for evidence-oriented adjacent investigations. Do not assert Linux/macOS REA RPX support without a verified test of custom-loader admission.

- [REA Windows P0](https://github.com/morluto/rea/blob/main/docs/windows-ghidra-p0.md)
- [REA provider semantics](https://github.com/morluto/rea/blob/main/docs/ghidra-provider.md)
- [REA installation](https://github.com/morluto/rea/blob/main/docs/installation.md)

## Milestones derived from upstream patterns

- M0: CPU correctness regressions and cross-compiler generated-C execution tests pass on synthetic input.
- M1: verified section/data image, checked relocations, typed HLE and observable headless entry.
- M2: deterministic multi-function boot trace (no silent HLE success) and sharded compiled output.
- M3: synthetic GX2 framebuffer, command logging, shader/texture backend benchmark and first present.
- M4: increasingly complete user-owned BotW boot/resources/input/audio/gameplay and performance, with status verified separately per feature.

Refer to the [engineering audit](../audits/2026-10-18-code-audit.md) and [implementation plan](../architecture/implementation-plan.md) for blockers and acceptance criteria.

## Evidence and reuse rules

All linked upstream README/architecture pages were inspected on 2026-10-18. Some upstream claims are self-reported; do not convert them into independently verified BotW compatibility. No external source has been copied into this file, and third-party licenses require review before integration. The current clean-room policy and user-owned inputs remain in force.
