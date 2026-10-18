# 2. Port approach: options and evaluation criteria

- **Date:** 2026-10-18
- **Status:** draft — **no decision taken yet**; this file collects the
  options and the criteria so Phase 2 can close quickly once evidence is in

## Context

Facts verified so far (see
[`docs/research/2026-10-rpx-format-notes.md`](../../research/2026-10-rpx-format-notes.md))
that constrain every option:

- The Wii U build is a **stripped ELF32 big-endian PowerPC binary**;
  `.text` alone is ~35.3 MiB (36,994,060 bytes) of machine code. There are
  no internal function names to lean on — everything inside the engine is
  reconstruction work.
- The binary calls into Cafe OS through **437 named function imports**
  across 15 system libraries (`gx2`, `coreinit`, `snd_core`, `snd_user`,
  `h264`, `nn_save`, `nn_act`, `nn_boss`, `nn_aoc`, `nn_nfp`, `padscore`,
  `vpad`, `proc_ui`, `sysapp`, `zlib125`, plus `nsysnet`/`nn_ac` slots).
  Whoever executes this code must provide those services.

Every approach must therefore answer two questions:

1. **How does the game code run?** — translate it, rebuild it, or emulate
   the original CPU.
2. **How are Cafe OS services provided?** — high-level emulation, original
   implementations, or a mix.

## Options

### A. Static recompilation + original runtime (HLE everywhere)

Translate the PowerPC binary ahead of time into native code (the technical
model of N64-era recompilation projects, with our own tooling), and ship an
original runtime implementing the imported Cafe OS APIs — including a GX2
command layer on top of Vulkan/OpenGL. The user's own data files supply
all content.

- **Pros:** at the end you run the real game logic; physics, AI and quests
  come along for free; lands incrementally, subsystem by subsystem; the
  strongest long-term ceiling.
- **Cons:** code size is roughly an order of magnitude beyond known
  recomp targets; indirect calls, C++ constructs and switch tables make
  lifting imperfect; a GX2→Vulkan layer is a major project in itself;
  differential testing needs a reference emulator harness.

### B. Engine reimplementation (original code, user's data)

Original engine code that parses the game's formats (SARC, BYML, AAMP,
BFRES, …) and rebuilds gameplay logic from scratch, informed by research.

- **Pros:** cleanest provenance story; each format loader is small and
  immediately testable; tooling (viewers, converters) is useful on its own.
- **Cons:** scope is effectively unbounded; will never reproduce the full
  game in any realistic horizon; behavior differences are inherent.

### C. Tooling around existing emulators

Original companion tools for existing emulators (configs, patchers, asset
browsers). Not a port by this project's definition; recorded only for
completeness and explicitly not the goal of the roadmap.

### D. Hybrid: translated core, emulated hard parts

A pragmatic mix: translate or rebuild CPU-side logic where practical, and
emulate OS/GPU services with emulator-grade components until those can be
replaced natively. Same legal shape as A; converges toward A over time.

## Evaluation criteria (priority order)

1. **Legal safety** — zero Nintendo content in the repository.
2. **Reproducibility** — a user with their own copy + this repo can build
   and run it.
3. **Incremental progress** — something demonstrable each phase, feasible
   on modest hardware.
4. **Prior art / precedent** — see
   [`docs/legal/prior-art.md`](../../legal/prior-art.md).
5. **Long-term ceiling** — what the project can ever become.

## Decision

**Deferred — explicitly a maintainer decision** (Phase 2 deliverable per
the [roadmap](../../../ROADMAP.md)). Evidence still to gather:

- Ghidra census of the binary (function count, control-flow quality).
- Decompilation sample study (how clean do typical functions come out?).
- Inventory of hard spots: indirect calls, computed jumps, TLS, exception
  handling, C++ runtime usage.

When that evidence lands, this ADR gets a filled-in decision section and
its status changes to `accepted` (or the decision is recorded in a new
ADR that supersedes this one).

## Consequences

- Whatever is chosen, Phase 1 artifacts (`tools/rpxinfo`, format notes,
  the Ghidra project) remain directly useful.
- Keeping this file as the shared "options board" anchors later design
  discussions to the same criteria instead of re-litigating from scratch.
