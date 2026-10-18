# Prior art reconnaissance: recompilation, decompilation and Wii U ports

- **Date:** 2026-10-18
- **Scope:** survey of public projects that do the same class of work as
  BotW-PC, and what their state (as observed today) means for our Phase 2
  decision. Written in response to: "you could save time by studying port
  attempts and finished ports".
- **Method:** web search + direct review of the projects' repositories and
  documentation. Everything below is public information; nothing from the
  game or from those repositories is copied into this project.

## Why this survey

Until now, the port options in
[ADR-0002](../architecture/decisions/0002-port-approach.md) were evaluated
in the abstract. The 2026 ecosystem, however, contains **working,
same-console (Wii U), same-game-family precedents** — including a Wii U
*Zelda* port built exactly on the option we considered most speculative.
This note records the findings; the ADR records the recommendation.

## 1. Same game, other platform: `zeldaret/botw`

- **What it is:** matching decompilation of *Breath of the Wild*
  **v1.5.0 (Switch)**. ~2.3k stars, active. Explicitly *not* a port
  ("Porting the game to other platforms is explicitly a non-goal",
  <https://botw.link/about>).
- **Why it matters to us anyway:**
  - **Same game version.** Our target is the Wii U update **v208**, which
    corresponds to the **1.5.0** release family — the same game version the
    decompilation targets.
  - **Names-only function database.** The repository publishes
    `data/uking_functions.csv` — fetched and inspected locally on
    2026-10-18: **113,490 entries, 72,243 with names** (50,237 of them
    mangled C++ names), plus quality codes. Also `data_symbols.csv`
    (data symbols) and `as_element_vtables.yml` (vtable layouts).
  - The database names the exact framework structures our own RE has been
    mapping on the Wii U binary — e.g. `uking::frm::RootTask`
    (`prepare` 432 B, `enter`, `calc` 3,908 B, `exit`, `dtor`),
    `sead::TTaskFactory<RootTask>`, `sead::GameFrameworkNx`
    (`initializeGraphicsSystem(sead::Heap*, sead::Vector2f const&)`,
    `presentAsync_(sead::Thread*, s64)`, `swapBuffer_`, `runImpl_`),
    `sead::SingleScreenMethodTreeMgr::{calc, draw}`, and
    `uking::frm::System::{preCalc, calcAndRunStateMachine, postCalc}`.
  - A companion fork of the same project runs a source browser at
    <https://codeviewer.zeldamods.org/uking/uking/> (leoetlino/uking).
- **Our Wii U binary is stripped**: verified with our own `tools/rpxinfo`
  — the RPX symbol table has **483 entries** (sections, imports, a handful
  of objects). No free names exist on the Wii U side; the Switch database
  is used as *vocabulary*, never as Wii U addresses.
- **Hygiene:** the database is fetched locally into a git-ignored folder
  (`tools/fetch-symbol-data.ps1`), is names/addresses only, and no code
  from that project is copied into this MIT repository.

## 2. Same console, finished port: `ZeldaWWHDRecomp` (Wind Waker HD)

The closest working precedent: a **static recompilation of a Wii U Zelda
title running natively on Windows, Linux, macOS and Android** —
no Cemu runtime, no GPU command emulation. MPL-2.0, ~740 stars.

Its `docs/how-it-works.md` is effectively the architecture spec for this
class of port. Summary of the moving parts:

| Concern | Their approach |
| ------- | -------------- |
| CPU | Ahead-of-time PowerPC→C, one C function per guest function, registers in a `Cpu` struct passed to each call; branches as `goto`s, calls as C calls, tail calls guaranteed with Clang `musttail`; indirect branches via a dispatch table. |
| Memory | Guest space mapped at a fixed host address; loads/stores are byte-swapped host accesses (big-endian guest). |
| Exact semantics where it matters | Paired-single math, GQR quantization, `fres`/`frsqrte` tables, single-precision rounding with FMA contraction disabled, `lwarx`/`stwcx.` as compare-and-swap, real memory barriers for `sync`/`lwsync`/`eieio`. |
| Cafe OS (HLE) | Threads are host threads, but guest code runs only while the thread holds its **emulated core** — one thread per core, strict priorities, preemption at function entry. This was required: letting same-core threads run in parallel corrupted shared data. Mutexes/events/queues keyed by guest address; heaps on host allocators; file system maps to extracted files + a local `save/`. |
| GX2 | The GX2 API itself is implemented (no PM4 packets): register file mirroring Latte, own compact command queue, render thread translating to Metal/Vulkan. Textures detiled with Cemu's AddrLib; uploaded textures are write-watched (mprotect + hash re-upload) because the game does not announce every write. |
| Shaders | Cemu's Latte microcode decompiler (vendored, MPL-2.0), MSL backend, persistent shader cache. |
| Presentation | 60 Hz vsync, swap-interval modelling, sRGB TV buffer, separate GamePad window. |
| Distribution | "No game code, no game assets and no keys"; the game is recompiled **locally on the user's machine from their own dump** (pinned compiler, SHA-256 checked RPX). |
| Trajectory | Has a decompilation companion project and an experimental **"decomp build"** — recompiled code is gradually replaced by decompiled source. This is the OoT→Ship-of-Harkinian path in action. |

## 3. Generic Wii U toolkits: `nWiiURecomp`

- `BlackLineInteractive/nWiiURecomp` (GPL-3.0, 2026, early): "static
  recompilation and runtime toolkit for Nintendo Wii U executables".
  Components: RPX analyzer (with a Ghidra export script that emits a
  per-game profile + symbol CSV), offline PPC→C++ recompiler, Cafe OS
  runtime with **interpreter fallback + HLE hooks keyed by guest address**,
  and a GUI debugging tool. Currently validated on Wind Waker HD only;
  per-game `.toml` profiles are the extension mechanism.
- Uses and credits: decaf-emu (RPX/RPL loaders, Cafe OS kernel/syscalls),
  WiiUBrew (GX2 docs), Cemu (host), CafeGLSL (shader compiler), rpl2elf,
  GhidraRPXLoader.
- **License note:** GPL-3.0. For this MIT repository it is *reading
  material*, not a code donor.

## 4. Same game, unreleased prototype ("Mindstormman")

Multiple outlets (2026) report a private Wii U "lifter" with **BotW
playable in prototype form** (bugs and performance pending), also tried on
Super Mario 3D World, Mario Kart 8, NSMBU and Splatoon; a repository is
promised once stable, nothing public yet. Take-away: the path is
technically feasible **on this exact game**; we do not depend on it.

## 5. PowerPC recompilation beyond Wii U (proven patterns)

- **XenonRecomp** (MIT, ~6.6k stars): Xbox 360 (also **big-endian
  PowerPC**) executable → C++. Documents the practical solutions we will
  need: function-boundary analysis (`.pdata` + branch-link scan), jump
  tables via pattern analysis (`mtctr`+`bctr`) with manual overrides,
  indirect calls via a perfect-hash lookup, hooks (weak aliasing + mid-asm
  inserts), native `setjmp`/`longjmp`, no exceptions support, and
  big-endian load/store and vector handling honesty.
- **UnleashedRecomp** (GPL-3.0, ~5.2k stars): a **shipped** port built
  with it (Sonic Unleashed): installer requires the user's own files, new
  renderer translating draw calls, kernel HLE layer, high-FPS/ultrawide
  work. The best public example of the end state.

## 6. Component sources we can legitimately reuse

| Source | License | What it provides |
| ------ | ------- | ---------------- |
| [Cemu](https://github.com/cemu-project/Cemu) | MPL-2.0 | Latte shader decompiler, address library (tiling/detiling), register definitions, some GX2 layouts — exactly the set WWHD's port vendors. |
| [decaf-emu](https://github.com/decaf-emu/decaf-emu) | GPL-2.0 | RPX/RPL loader knowledge and Cafe OS syscall documentation (reference). |
| [WiiUBrew GX2 pages](https://wiiubrew.org/wiki/Hardware/GX2) | docs | GX2 hardware/API documentation. |
| [CafeGLSL](https://github.com/Exzap/CafeGLSL) | open source | GX2 shader compiler alternative / understanding. |
| [rpl2elf](https://github.com/Relys/rpl2elf), [GhidraRPXLoader](https://github.com/decaf-emu/GhidraRPXLoader) | OSS | RPX parsing references (we already have our own `tools/rpxinfo`). |
| mpl-2.0 note | — | MPL is file-level: vendored MPL files stay MPL with headers intact; they can live next to MIT code. GPL code cannot be mixed into this MIT repo. |

## What this changes for us

1. **Option A of ADR-0002 is no longer speculative.** "Static
   recompilation + HLE runtime" has a *working* Wii U implementation
   (Wind Waker HD), a generic toolkit, and a reported proof of concept on
   BotW itself. The risks that remain are engineering scale and quality of
   the GX2 layer — not feasibility.
2. **The long-term convergence path is also visible:** recompiled code →
   replace subsystems with decompiled source as `zeldaret/botw` matures
   (the WWHD "decomp build" pattern). Our clean-room notes and tools
   already feed exactly that workflow.
3. **Naming:** use the public names-only database to organize our RE
   (classes, method names, sizes) while keeping the port's hook/symbol
   naming anchored to the **Wii U v208 addresses** (canonical build), the
   same discipline WWHD uses across regional builds.
4. **Scope drivers confirmed by both precedents:**
   - the recompiler itself is bounded and incremental;
   - the runtime/HLE layer must reproduce **Cafe OS thread/core
     scheduling**, or the game corrupts state;
   - the GX2 implementation only needs the functions *this game* calls —
     and we already have a complete import → call-site map from Phase 1
     (437 imports, 16,736 call sites);
   - shader translation should *not* be written from scratch: Cemu's
     MPL-2.0 decompiler exists for exactly this.
5. **Distribution model is settled by precedent:** tools + runtime in the
   repository; everything game-derived (recompiled code, extracted files,
   shader caches) is generated locally from the user's own dump; a future
   runtime checks the user's `U-King.rpx` against the expected v208 hash
   and refuses anything else.

## Open risks

- **Effort**: the GX2 and thread-scheduling layers are the known hard
  parts; both have reference implementations, neither is trivial.
- **Decompilation maturity**: zeldaret/botw is years from complete; the
  port must not depend on it. It is a vocabulary source and a future
  accelerator only.
- **Platform drift**: our port targets one exact build (Wii U update
  v208); other versions would need their own translation pass.
- **License separation** must be kept tidy: GPL projects are studied,
  MPL components are vendored as MPL files if/when used.

## Sources

- <https://github.com/zeldaret/botw> (and `data/uking_functions.csv`)
- <https://botw.link/about> — project charter and non-goals
- <https://github.com/leoetlino/uking> — fork + code browser
- <https://github.com/leoetlino/botw-re-notes/blob/master/symbols.md> —
  "releases are stripped; sead code is shared with Super Mario Odyssey"
- <https://github.com/ZeldaWWHDRecomp/ZeldaWWHDRecomp> and its
  `docs/how-it-works.md` — working Wii U recompilation
- <https://github.com/BlackLineInteractive/nWiiURecomp> — generic Wii U
  toolkit (GPL-3.0)
- <https://github.com/hedge-dev/XenonRecomp> and
  <https://github.com/hedge-dev/UnleashedRecomp> — PowerPC recompilation
  + shipped port
- <https://github.com/N64Recomp/N64Recomp> and
  <https://github.com/Zelda64Recomp/Zelda64Recomp> — the lineage
- Press coverage of the unreleased BotW Wii U "lifter" prototype (2026)
