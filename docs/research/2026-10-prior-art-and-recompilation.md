# Prior art reconnaissance: recompilation, decompilation and Wii U ports

- **Date:** 2026-10-18; **updated 2026-10-22** after public exact-v208
  projects were found.
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
  <https://botw.link/about>). On 2026-10-22 the progress badges report
  **32.794% of functions and 20.264% of bytes** — further along than the
  "very early" label in the original survey.
- **License:** the repository has **no `LICENSE`/`COPYING` file** and
  GitHub reports no license. Default copyright therefore applies: source
  and headers are reference-only, not donor code.
- **Why it matters to us anyway:**
  - **Same game version.** Our target is the Wii U update **v208**, which
    corresponds to the **1.5.0** release family — the same game version the
    decompilation targets.
  - **Names-only function database.** The repository publishes
    `data/uking_functions.csv` — refetched and inspected locally on
    2026-10-22: **113,491 entries, 84,442 with names** (58,357 of them
    mangled C++ names), plus quality codes. The older 113,490 / 72,243
    counts in this note were from 2026-10-18 and are superseded. Also
    `data_symbols.csv` (data symbols) and `as_element_vtables.yml` (vtable
    layouts).
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

## 4. Same game, public exact-v208 recompilations (2026-10-22 update)

The earlier "unreleased prototype" claim is obsolete. Public repositories
now target the **exact Wii U v208 binary**, including its SHA-256:

- **`IshaanKalra2103/BotWRecomp`** — MIT for its own code plus Cemu
  MPL-2.0 components; recompiler and Cafe OS runtime for macOS/iOS. The
  author reports playable results on an iPhone 16 Pro and an M1 Pro Mac.
  The tree registers **488 unique HLE names** and covers **424 of our 437
  function imports**; the 13 missing names are all H.264 video decode.
  One squashed commit and a "built with Claude Code" README mean the
  provenance still needs an audit before any code reuse.
- **`P1kaCat/Breath-of-The-Wild-Compiled`** — Windows; exact same v208
  hash; based on `CafeRecomp` commit
  `922b852e56cd440d23ed8ede3e0b86495e68967f`. It renders the opening screen
  and the start of the intro, but 3D is incomplete and it is not playable.
  MPL-2.0 overall with **DolRecomp GPL-3.0** and Cemu MPL-2.0; reference
  only for this MIT repository.
- **`hardkiller2565123123/CafeRecomp`** — the upstream generic Wii U
  recompilation framework, MPL-2.0 plus bundled DolRecomp GPL-3.0 and Cemu
  MPL-2.0. Early working prototype, not a finished port.

Full review with licenses, counts and reuse boundaries:
[`2026-10-22-botw-decompilation-and-recompilation.md`](2026-10-22-botw-decompilation-and-recompilation.md).
Take-away: the path is not merely technically feasible; a public exact-v208
implementation exists. The open decision is whether to audit/adapt the MIT
line, collaborate with the Windows GPL line, or continue the independent
clean-room runtime.

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
   (Wind Waker HD), a generic toolkit, and now public exact-v208
   implementations of BotW itself. The MIT project reports playable
   results and covers 424/437 of our imports. The risks that remain are
   provenance, Windows portability and quality of the GX2 layer — not
   feasibility.
2. **The long-term convergence path is also visible:** recompiled code →
   replace subsystems with decompiled source as `zeldaret/botw` matures
   (the WWHD "decomp build" pattern). That path is blocked for now by the
   decompilation's missing license, so it is vocabulary/future work, not a
   current donor.
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
- **Decompilation maturity and license**: zeldaret/botw is at 32.794% of
  functions, years from complete, and publishes no license. The port must
  not depend on it; it is vocabulary and future work only.
- **Provenance of the fast path**: the MIT exact-v208 project has a
  one-commit history and says it was built with Claude Code. Its Cemu
  files are clearly MPL-2.0, but the rest needs a provenance audit before
  we import anything.
- **Platform drift**: our port targets one exact build (Wii U update
  v208); other versions would need their own translation pass. The MIT
  implementation is macOS/iOS/Metal-only today; a Windows backend is new
  work, not a compile flag.
- **License separation** must be kept tidy: GPL projects are studied,
  MPL components are vendored as MPL files if/when used, and the MIT
  project's provenance must be documented file by file.

## Sources

- <https://github.com/zeldaret/botw> (and `data/uking_functions.csv`)
- <https://botw.link/about> — project charter and non-goals
- <https://github.com/leoetlino/uking> — fork + code browser
- <https://github.com/leoetlino/botw-re-notes/blob/master/symbols.md> —
  "releases are stripped; sead code is shared with Super Mario Odyssey"
- <https://github.com/IshaanKalra2103/BotWRecomp> — MIT exact-v208
  recompilation and runtime
- <https://github.com/P1kaCat/Breath-of-The-Wild-Compiled> — Windows port
  (MPL-2.0 + DolRecomp GPL-3.0)
- <https://github.com/hardkiller2565123123/CafeRecomp> — generic Wii U
  recompilation framework (MPL-2.0 + GPL-3.0 components)
- <https://github.com/DenisGames54/BotWRecomp-Android> — Android fork
- <https://github.com/ZeldaWWHDRecomp/ZeldaWWHDRecomp> and its
  `docs/how-it-works.md` — working Wii U recompilation
- <https://github.com/BlackLineInteractive/nWiiURecomp> — generic Wii U
  toolkit (GPL-3.0)
- <https://github.com/hedge-dev/XenonRecomp> and
  <https://github.com/hedge-dev/UnleashedRecomp> — PowerPC recompilation
  + shipped port
- <https://github.com/N64Recomp/N64Recomp> and
  <https://github.com/Zelda64Recomp/Zelda64Recomp> — the lineage
