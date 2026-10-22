# 2. Port approach: options and evaluation criteria

- **Date:** 2026-10-18
- **Status:** accepted — maintainer sign-off recorded 2026-10-18; the
  recommendation below is adopted (see *Decision*)

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

## Evidence gathered (2026-10-18)

Reconnaissance of public prior art changed the state of this question:
option A is no longer hypothetical — least of all on Wii U. Full write-up:
[`docs/research/2026-10-prior-art-and-recompilation.md`](../../research/2026-10-prior-art-and-recompilation.md).

- **A working Wii U precedent exists.** ZeldaWWHDRecomp (MPL-2.0) runs
  *Wind Waker HD* natively on Windows/Linux/macOS/Android with exactly the
  shape of option A: ahead-of-time PowerPC→C translation, Cafe OS
  reimplemented natively, GX2 implemented directly on Vulkan/Metal (no
  command-packet emulation; Cemu's MPL-2.0 shader decompiler and address
  library vendored). Its `docs/how-it-works.md` is the de-facto
  architecture spec for this class of port.
- **A general Wii U toolkit exists.** nWiiURecomp (GPL-3.0, early) ships
  an RPX analyzer (with a Ghidra export script), an offline PPC→C++
  recompiler and a Cafe OS HLE runtime skeleton. License: reading
  material only for this MIT repository.
- **On this exact game.** Public exact-v208 projects existed by
  2026-10-22: `IshaanKalra2103/BotWRecomp` (MIT + Cemu MPL-2.0;
  macOS/iOS; author reports playable) covers **424 of our 437 function
  imports**, and `P1kaCat/Breath-of-The-Wild-Compiled` (Windows;
  MPL-2.0 + DolRecomp GPL-3.0) renders the opening screen and the start
  of the intro but is not playable. Feasibility on this title is no longer
  informal. See
  [`docs/research/2026-10-22-botw-decompilation-and-recompilation.md`](../../research/2026-10-22-botw-decompilation-and-recompilation.md).
- **Naming material for the same game version.** `zeldaret/botw` publishes
  a names-only function database for Switch 1.5.0 (113,491 entries;
  84,442 named — refetched locally 2026-10-22) — the same release family
  as our Wii U v208 target. The decompilation is now at 32.794% of
  functions / 20.264% of bytes. Our RPX itself is stripped (483 symbols —
  sections and imports only, verified with `tools/rpxinfo`). The database
  provides vocabulary (`sead::GameFrameworkNx`, `uking::frm::RootTask`, …)
  and is fetched locally, never committed. The decompilation repository
  has **no license file**, so it is reference-only; no source or headers
  are copied.
- **PowerPC static recompilation is a solved pattern beyond Wii U.**
  XenonRecomp (MIT) + UnleashedRecomp (GPL-3.0) did it for the Xbox 360
  (also big-endian PowerPC) with documented lessons on function
  boundaries, jump tables, indirect calls and hooks.
- **The known hard parts are documented**: exact guest semantics
  (paired-single, GQR, `lwarx`/`stwcx.`, memory ordering), Cafe OS
  thread/core scheduling fidelity, texture write-watching, shader
  translation — each has at least one public reference implementation.

## Recommendation (adopted)

Adopt **option A — static recompilation + original HLE runtime** as the
primary direction, structured as **option D in time**: land subsystems
incrementally behind HLE stubs, with two documented migration targets —
native GX2 on Vulkan (short/medium term, WWHD-style) and replacement by
`zeldaret/botw` source as that decompilation matures (long term). Option B
remains out of scope as a standalone effort; option C stays excluded.

Conditions that keep this legal and consistent with the clean-room policy:
recompilation happens **locally, at build time, from the user's own copy**;
the repository ships tools, runtime and docs only; the public symbol
database is fetched locally (names only, git-ignored) and never committed;
GPL-licensed prior art (nWiiURecomp, UnleashedRecomp, decaf-emu) is read,
never copied into this MIT repository; any vendored MPL-2.0 components
(e.g. Cemu's) keep their license and headers.

## Decision

**Accepted (maintainer sign-off, 2026-10-18):** adopt **option A — static
recompilation + original HLE runtime**, structured as **option D in time**:
land subsystems incrementally behind HLE stubs, with two documented
migration targets — native GX2 on Vulkan (short/medium term) and
replacement by `zeldaret/botw` source as that decompilation matures (long
term). Option B remains out of scope as a standalone effort; option C stays
excluded.

Evidence at decision time (the items previously listed as pending):

- **Ghidra census:** 96,874 branch-derived function starts
  ([2026-10-ghidra-census.md](../../research/2026-10-ghidra-census.md)).
- **Decompilation sample:** the Phase 2 prototype (`tools/ppcx` +
  `src/runtime`) translates real engine functions to C and runs an
  end-to-end demo function against the HLE runtime
  ([2026-10-recompiler-prototype.md](../../research/2026-10-recompiler-prototype.md)).
- **Hard spots:** indirect calls route through the runtime dispatcher, tail
  calls and ADDR16 import addresses are handled, the enumerated opcode gap
  (`psq_l`/`psq_st` and the indexed forms) is implemented and differentially
  tested (2026-10-19), and big-endian memory plus single-threaded
  reservations are modelled in the runtime.

## Post-decision update (2026-10-22): public exact-v208 implementations

The accepted architecture does **not** change. The build-vs-adopt question
does, and it now needs an explicit maintainer decision before any code is
imported:

- `IshaanKalra2103/BotWRecomp` is an MIT + Cemu MPL-2.0 implementation of
  this exact v208 binary. It registers 488 HLE names and covers 424/437 of
  our function imports; its README reports playable iPhone/Mac results.
  It is macOS/Metal-only, has a one-commit history and says it was built
  with Claude Code. Provenance must be audited before reuse.
- `P1kaCat/Breath-of-The-Wild-Compiled` is the closest Windows codebase
  but bundles DolRecomp GPL-3.0; it cannot donate code to this MIT repo.
- `zeldaret/botw` remains reference-only (no license, Switch build).

Options for the maintainer: (A) continue the independent clean-room
runtime; (B) audit and adapt the MIT exact-v208 recompiler/runtime behind a
new Windows backend; (C) collaborate with the Windows GPL line behind a
separate license boundary. Until one is chosen, no public project's code is
merged. The survey and evidence are in
[`docs/research/2026-10-22-botw-decompilation-and-recompilation.md`](../../research/2026-10-22-botw-decompilation-and-recompilation.md).

## Consequences

- Whatever is chosen, Phase 1 artifacts (`tools/rpxinfo`, format notes,
  the Ghidra project) remain directly useful.
- Keeping this file as the shared "options board" anchors later design
  discussions to the same criteria instead of re-litigating from scratch.
