# Prior art: how comparable projects stay legal

> Informative only — not legal advice. Last reviewed: 2026-10-22.

Before writing a line of code, we surveyed the established projects that do
the same kind of work and extracted the formula that has kept them online.

## The reference projects

| Project | What it is | What it ships | Legal formula |
| ------- | ---------- | ------------- | ------------- |
| [zeldaret/oot](https://github.com/zeldaret/oot) | Matching decompilation of Ocarina of Time | C/C++ source only. "This repository does not include any of the assets necessary to build the ROM. A prior copy of the game is required to extract the needed assets." | Clean-room process (no leaked material, documented tooling), zero assets, user-supplied copy. |
| [Ship of Harkinian](https://github.com/HarbourMasters/Shipwright) (OoT PC port) | Native PC port built on the decomp + original `libultraship` code | Original code and binaries. "The Ship does not include any copyrighted assets. You are required to provide a supported copy of the game." | Assets are generated **locally** from the user's own ROM; strict no-piracy community policy. |
| [Zelda 64: Recompiled](https://github.com/Zelda64Recomp/Zelda64Recomp) | Static recompilation of Majora's Mask to native PC | Original tooling/runtime. "This repository and its releases do not contain game assets. The original game is required to build or run this project." | Recompilation runs against the user's own ROM at build/run time; everything else is original code. |
| [zeldaret/botw](https://github.com/zeldaret/botw) | Matching decompilation of BotW **Switch 1.5.0**; 32.794% of functions / 20.264% of bytes (2026-10-22) | Source only. "This repository does not contain game assets or RomFS content and cannot be used to play Breath of the Wild." Also publishes a **names-only symbol database** (`data/uking_functions.csv`, 113,491 rows, 84,442 named on 2026-10-22). **No LICENSE/COPYING file**; GitHub reports no license, so default copyright applies. | Research/vocabulary only: facts, names and class-layout hypotheses. The names DB is fetched locally into a git-ignored folder; no source, headers or build files are copied. |
| [BotWRecomp](https://github.com/IshaanKalra2103/BotWRecomp) | Public static recompilation of the **exact Wii U v208** build (SHA-256 `ba58da5b…34d30`) for iPhone and Apple Silicon Macs; author reports playable results | Original recompiler and Cafe OS runtime, no game files or game code; generated code is local. **MIT** for its own code plus **Cemu MPL-2.0** components. One squashed commit, built with Claude Code; provenance audit required before code reuse. | Strongest feasibility proof for our exact target and the only public exact-v208 codebase whose license is compatible in principle. Not adopted here yet: audit provenance, respect MPL files, and note that the current backend is macOS/Metal-only. |
| [BOTW Compiled](https://github.com/P1kaCat/Breath-of-The-Wild-Compiled) | Windows port of the same v208 build; opening screen and start of the intro render, 3D incomplete | Original Windows runtime/tools; no game data. **MPL-2.0** overall, but explicitly bundles **DolRecomp GPL-3.0** from CafeRecomp, plus Cemu MPL-2.0. | Reference only for this MIT repo: GPL files cannot be copied. Transparent `SOURCE-PROVENANCE.md` and license notices make it a useful Windows collaboration target behind a separate boundary. |
| [CafeRecomp](https://github.com/hardkiller2565123123/CafeRecomp) | Generic Wii U static-recompilation framework, focused on BotW; early working prototype | Original framework/tools only; game files are user-supplied | MPL-2.0 project but bundles **DolRecomp GPL-3.0** and Cemu MPL-2.0. Reference only for this MIT repo; reusable only with a clean license boundary. |
| [ZeldaWWHDRecomp](https://github.com/ZeldaWWHDRecomp/ZeldaWWHDRecomp) | Native PC/Android port of *Wind Waker HD* (Wii U) via static recompilation (MPL-2.0) | Original runtime/tools only. "This repository contains no game code, no game assets and no keys …"; everything game-specific "is generated locally on your machine from your dump, and must not be redistributed." | The same formula applied to a Wii U title: recompile locally from the user's own dump; GX2→Vulkan/Metal implemented natively; Cemu's MPL-2.0 components vendored with license intact. |
| [XenonRecomp](https://github.com/hedge-dev/XenonRecomp) + [UnleashedRecomp](https://github.com/hedge-dev/UnleashedRecomp) | Static recompiler for big-endian PowerPC (Xbox 360) and a shipped port built with it | "This project does not include any game assets. You must provide the files from your own legally acquired copy of the game." | Recompilation output is generated locally from user-provided files; tooling is original (MIT / GPL-3.0). |
| [nWiiURecomp](https://github.com/BlackLineInteractive/nWiiURecomp) | Generic Wii U static recompilation toolkit (GPL-3.0, early) | Tools and runtime only, no game data | GPL tool we may study — not copied into this MIT repository. |
| [leoetlino/botw-re-notes](https://github.com/leoetlino/botw-re-notes) + [ZeldaMods wiki](https://zeldamods.org/) | Public format/protocol research for BotW | Documentation and original tools only | Facts and format documentation, no game content. |

zeldaret is the umbrella for matching decompilations (OoT, MM, TP, TWW, SS,
BotW, …). Its charter is **research, not ports** — ports (like Ship of
Harkinian) and recompilations are downstream community work that consumes the
research without shipping anything from the games.

## The formula we adopt

1. **Zero Nintendo content in this repository.** No assets, no ROM/RomFS
   content, no executables, no keys. Original code and documentation only.
2. **User-supplied copy.** Any extraction, translation, or recompilation
   happens locally, from a copy the user legally owns, on the user's machine.
3. **No leaked material.** We do not use or reference leaked source code,
   internal SDKs, or anything that was not obtained through lawful
   reverse engineering or public documentation.
4. **Transparent, documented process.** Our tooling, workflow, and policies
   are public (you are reading part of them).
5. **No piracy facilitation.** No links, no hints, no "ask in DMs".
6. **Release discipline.** Any future binaries we distribute are ours alone —
   never a bundle of game data, and never something usable to play the game
   without a legally obtained copy.

## Risk honesty

Nintendo actively enforces its rights: projects that ship game data,
emulators of current hardware, or leaked content have been taken down. The
projects above have stayed available because they ship none of that — but
this is a *pattern*, not a guarantee. If a rights holder ever contacts this
project, our first response is compliance: content comes down, discussion
follows. The long-term goal (a PC port) is downstream of staying legal; never
the reverse.

## Notes specific to Breath of the Wild

- zeldaret/botw targets the **Switch 1.5.0** decompilation and is **not
  playable**; it states "don't expect a port soon". On 2026-10-22 its
  progress badges report **32.794% of functions / 20.264% of bytes**. It
  publishes a **names-only function database** for that build
  (`data/uking_functions.csv`, **113,491 rows and 84,442 named** on
  2026-10-22) — the same game version family as our Wii U v208 target. The
  repository has **no license file**, so we use only names/facts as local,
  git-ignored vocabulary and copy no source from it.
- The 2026 state of the art for this exact class of port is **static
  recompilation + native HLE**. It is demonstrated end-to-end on a Wii U
  Zelda title
  ([ZeldaWWHDRecomp](https://github.com/ZeldaWWHDRecomp/ZeldaWWHDRecomp))
  and now publicly on **BotW v208 itself**:
  [BotWRecomp](https://github.com/IshaanKalra2103/BotWRecomp) (MIT + Cemu
  MPL-2.0, macOS/iOS; author reports playable) and
  [BOTW Compiled](https://github.com/P1kaCat/Breath-of-The-Wild-Compiled)
  (Windows, MPL-2.0 + GPL-3.0; opening/intro only). See
  [`docs/research/2026-10-prior-art-and-recompilation.md`](../research/2026-10-prior-art-and-recompilation.md)
  and the 2026-10-22 deep review
  [`docs/research/2026-10-22-botw-decompilation-and-recompilation.md`](../research/2026-10-22-botw-decompilation-and-recompilation.md).
- The public exact-v208 work changes the **build-vs-adopt** question, not
  the license rules: the MIT project is a candidate upstream only after a
  provenance audit; the Windows project carries GPL-3.0 files and stays
  reference-only for this MIT repository.
- Our analysis targets the **Wii U** release (PowerPC), a different binary
  from the Switch build. We share the knowledge base of public formats
  (BYML, AAMP, SARC, BFRES, …) but copy nothing.
- BotW is orders of magnitude larger than the N64 titles. The realistic
  expectation for this project is incremental research milestones, not a
  finished port.
