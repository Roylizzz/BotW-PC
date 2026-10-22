# Public BotW decompilation and exact-v208 recompilation projects

- **Date:** 2026-10-22
- **Question:** what can the existing public BotW decompilation and
  recompilation work teach this project, and what can we legally reuse?
- **Method:** GitHub metadata + raw repository inspection, plus a local
  comparison of the public v208 runtime's HLE registrations against our own
  stripped `U-King.rpx` symbol table. No public repository was executed and
  no game-derived code was copied into this repository.
- **Evidence quality:** repository contents and counts are **observed**;
  playability, frame rate and device results are **author claims** unless
  explicitly marked as locally measured.

## Bottom line

The feasibility question is settled more strongly than the 2026-10-18 survey
knew. Public projects target the **exact same Wii U v208 binary** we do,
including its SHA-256:

`ba58da5b95ce929e005d058ceb08b9b2788d1ab2bbc8a6c189bbadca0bb34d30`.

- `IshaanKalra2103/BotWRecomp` is an **MIT-licensed** static recompiler and
  Cafe OS runtime for macOS/iOS. Its README claims the game is playable on
  an iPhone 16 Pro and an M1 Pro Mac. It registers **488** HLE names and
  covers **424 of our 437 function imports**; the 13 missing names are all
  H.264 video-decode imports. This is the closest public proof that our
  chosen architecture works on this title, and the only public codebase whose
  license is compatible with this MIT repository *in principle*.
- `P1kaCat/Breath-of-The-Wild-Compiled` is a **Windows** port of the same
  v208 hash. It is based on `CafeRecomp` and includes `DolRecomp` under
  **GPL-3.0**; it renders the opening screen and the start of the intro, but
  3D is incomplete and the game is not playable yet. It is the closest
  Windows reference, but its GPL files cannot be copied into this MIT repo.
- `zeldaret/botw` is a real matching decompilation of the **Switch 1.5.0**
  build: **32.794% of functions / 20.264% of bytes** (badge endpoints,
  2026-10-22). It is excellent vocabulary for class layouts and boot flow,
  but it has **no LICENSE file**, so we still cannot copy its source. It also
  has no Wii U addresses.

The strategic question is therefore no longer "is a BotW native port
possible?" It is "do we keep building an independent clean-room runtime, or
do we audit and adapt the MIT exact-v208 implementation?" That decision needs
maintainer sign-off; this note records the evidence, not a decision.

## 1. `zeldaret/botw` — Switch 1.5.0 matching decompilation

- **Repository:** <https://github.com/zeldaret/botw>
- **Target:** *Breath of the Wild* **v1.5.0 (Switch)**. The Wii U v208 update
  is the same 1.5.0 release family, but a different executable and
  instruction set.
- **Status (2026-10-22):** the public progress badges report **32.794% of
  functions** and **20.264% of bytes**. This is substantially further along
  than the "very early" description in our 2026-10-18 notes.
- **Scale:** the repository tree has **8,146 files**, including **7,707 under
  `src/`**: **3,722 `.cpp`** files (6,589,795 bytes) and **3,841 `.h`** files
  (5,042,758 bytes). The main directories are `src/Game` (6,730 files) and
  `src/KingSystem` (974 files).
- **Published data:** `data/uking_functions.csv`, `data/data_symbols.csv` and
  `data/as_element_vtables.yml`. A fresh fetch on 2026-10-22 gives
  **113,491 function rows**, **84,442 with names** and **58,357 mangled C++
  names** (the older note's 113,490 / 72,243 counts are stale).
- **License:** there is **no `LICENSE` or `COPYING` file** in the repository
  and GitHub reports no license. The default is therefore all rights
  reserved. We may use public **facts and names** as research vocabulary, but
  we must not copy source, headers or generated build files from it.
- **What it is useful for:** naming `uking::frm::RootTask`,
  `sead::GameFrameworkNx`, `sead::SingleScreenMethodTreeMgr` and the
  `ksys`/`sead` class layouts; understanding the boot and present flow; and
  future replacement of recompiled subsystems with decompiled ones if the
  project ever adds a compatible license.
- **What it is not:** a Wii U address map, an ABI reference for PowerPC, or a
  code donor. Class layouts can differ between the Switch and Wii U builds;
  every offset used by our runtime must still be confirmed against our own
  v208 image.

The names database remains fetched into `symbols-local/` by
`tools/fetch-symbol-data.ps1` and stays git-ignored. The fetch script and the
CSV are not redistributed. The `open-ead/sead`, `open-ead/agl`,
`open-ead/EventFlow` and `open-ead/nnheaders` repositories have the same
license problem: GitHub reports no license for them, so they are also
fact/reference material only.

## 2. `IshaanKalra2103/BotWRecomp` — MIT static recompilation for macOS/iOS

- **Repository:** <https://github.com/IshaanKalra2103/BotWRecomp>
- **Target:** Wii U **v208**, exact SHA-256
  `ba58da5b95ce929e005d058ceb08b9b2788d1ab2bbc8a6c189bbadca0bb34d30`.
- **Platforms:** iPhone (main target) and Apple Silicon Macs. The build uses
  Objective-C++, Metal, SDL3 and Apple frameworks; there is no Windows
  backend in the tree.
- **License:** **MIT** for the repository's own code, plus **Cemu MPL-2.0**
  components in `runtime/cemu` and vendored Cemu GX2 files in
  `runtime/src/gx2`. The README says it ships no game files or game code and
  recompiles the user's own RPX locally. The generated tree (`generated/`) is
  git-ignored.
- **What it contains:** a Python RPX analyzer/recompiler (`cafe/`,
  `tools/recompile.py`), a Cafe OS runtime (`runtime/src`) and a vendored
  Cemu Latte GPU path. The runtime has **97** C/C++/Objective-C++ source
  files, about **20,169 lines** outside Cemu, and **488 unique HLE
  registrations** across 14 libraries. Of our **437 function imports**, it
  registers **424**; the only unmatched names are the 13 `H264DEC*`
  video-decode functions. (Counts measured from the repository and our own
  `tools/rpxinfo` symbol table.)
- **Author's status claims:** boots and plays with touch controls on one
  iPhone 16 Pro, mostly 35–60 fps in the open world at about 2.4 GB, with a
  hang after about four minutes; on an M1 Pro, 60 fps in menus and 24–35 fps
  in the open world. These are **author claims**, not reproduced here: the
  host is Windows, we do not have the full game data set in the repository,
  and the project has no Apple CI in the public tree.
- **Provenance caveat:** the repository has **one commit**, a squashed
  history, and its README says it was built with Claude Code. The core
  runtime files carry no per-file copyright headers, while the Cemu-derived
  files do. We found no GPL notice in the non-Cemu runtime, but the absence
  of a notice is not proof of clean provenance. Treat the MIT code as a
  **candidate upstream after audit**, not as approved donor code today.
- **Why it matters:** it proves that the exact v208 binary, the full import
  surface (minus video decode), user-owned data, and a native GX2 path can
  coexist without shipping Nintendo content. It is also the most useful
  reference for our next architectural gap: scheduling, filesystem, GX2 and
  the shader path.

## 3. `P1kaCat/Breath-of-The-Wild-Compiled` — Windows, MPL + GPL

- **Repository:** <https://github.com/P1kaCat/Breath-of-The-Wild-Compiled>
- **Target:** Wii U v208, same SHA-256; European title identity.
- **Status:** the README and `VALIDATION.md` say the Windows x64 build starts
  the recompiled code, renders the opening screen and the beginning of the
  intro, and then fails to render Link/environment; the final capture is
  uniformly yellow and vertex programs are rejected. Not playable.
- **License/provenance:** the project is MPL-2.0 overall but explicitly
  includes **DolRecomp under GPL-3.0** from
  `hardkiller2565123123/CafeRecomp` commit
  `922b852e56cd440d23ed8ede3e0b86495e68967f`, plus Cemu MPL-2.0 files. Its
  `SOURCE-PROVENANCE.md` and license files are careful and transparent.
- **Boundary:** **do not copy any of it into this MIT repository.** GPL-3.0
  code cannot be relicensed as MIT. It remains a Windows reference and a
  possible collaboration target only if the project is kept behind a
  separate GPL boundary (or the relevant code is independently rewritten).

## 4. `CafeRecomp` — the upstream generic Wii U recompiler

- **Repository:** <https://github.com/hardkiller2565123123/CafeRecomp>
- **Status:** self-described first working Wii U recompilation framework,
  focused on BotW but intended to be reusable. Early prototype; not a
  finished port.
- **License:** MPL-2.0 for the project, but it bundles **DolRecomp GPL-3.0**
  and Cemu MPL-2.0. The same boundary applies: reference only for this MIT
  repository; MPL files would have to remain MPL with their notices intact
  if ever vendored.
- **Why it matters:** it is the base of the Windows `P1kaCat` port and
  documents a reusable RPX-analysis/runtime split. Its GPL component makes it
  unsuitable as a direct code donor for us.

The `DenisGames54/BotWRecomp-Android` repository is an Android/ARM64 fork of
`BotWRecomp`; it is not an independent implementation and adds no new
evidence for this survey.

## What this changes for BotW-PC

1. **Feasibility is no longer the risk.** A public exact-v208 implementation
   exists and reports playable results. Our ADR-0002 architecture is
   validated, but it is no longer the only plausible path. Continuing the
   clean-room runtime is a choice, not a necessity.
2. **The decompilation is a vocabulary source, not a donor.** `zeldaret/botw`
   gives us names, class-layout hypotheses and boot-flow structure. Its
   missing license and Switch/PowerPC differences rule out source reuse. The
   names database is still useful locally and remains non-redistributed.
3. **The build-vs-adopt decision is now the critical path.**
   - **A. Continue the independent clean-room runtime.** Keeps the current
     MIT-only provenance and the existing tests, but still requires a
     scheduler, filesystem, GX2, audio, input and a shader path.
   - **B. Audit and adapt the MIT `BotWRecomp`.** Fastest path to a running
     Windows build in principle: the recompiler and HLE surface already
     cover 424/437 imports. Requires a provenance audit, a Windows host/GPU
     backend (the current code is macOS/Metal-only), and Cemu MPL compliance.
   - **C. Collaborate with the GPL `P1kaCat`/`CafeRecomp` line.** Closest to a
     working Windows renderer, but incompatible with this repository's MIT
     license unless the collaboration is separated behind a GPL boundary or
     the code is independently reimplemented.
4. **The measured gap is now concrete.** Our registry models 51 of the 437
   function imports; the public MIT runtime registers 424. That is the scale
   of the remaining Cafe OS work, not a guess. A Windows adoption should
   reuse the *knowledge* first and only import files whose provenance and
   license are verified.
5. **Short term, nothing should be copied.** Finish the current measured
   mutex increment, keep the existing tests green, and use the decompilation
   to name the boot flow. Before any code reuse, record a provenance audit
   and an explicit maintainer decision.

## Recommended next step

Do **not** silently pivot the repository. The highest-value low-risk action is
a short, time-boxed spike: audit the MIT `BotWRecomp` history and file
provenance, then try its recompiler against our local v208 image in a
git-ignored directory and compare the generated function boundaries with our
Ghidra census. If provenance is clean, propose a Windows backend plan; if it
is not, keep the public projects as reference-only and continue the
independent runtime. Either way, the decompilation and the names database
remain useful.

## Sources

- <https://github.com/zeldaret/botw> — README, `AGENTS.md`, tree and
  `data/uking_functions.csv` (fetched 2026-10-22; local only).
- <https://botw.link/about> and <https://botw.link/progress> — project scope
  and progress.
- <https://github.com/IshaanKalra2103/BotWRecomp> — README, `LICENSE`,
  `cafe/`, `runtime/` and `CMakeLists.txt`.
- <https://github.com/P1kaCat/Breath-of-The-Wild-Compiled> — README,
  `SOURCE-PROVENANCE.md`, `VALIDATION.md`, license files and tree.
- <https://github.com/hardkiller2565123123/CafeRecomp> — README,
  `SOURCE-ORIGINS`, license files and tree.
- <https://github.com/DenisGames54/BotWRecomp-Android> — repository metadata
  and README (fork identification).
