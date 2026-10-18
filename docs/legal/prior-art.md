# Prior art: how comparable projects stay legal

> Informative only — not legal advice. Last reviewed: 2026-10-18.

Before writing a line of code, we surveyed the established projects that do
the same kind of work and extracted the formula that has kept them online.

## The reference projects

| Project | What it is | What it ships | Legal formula |
| ------- | ---------- | ------------- | ------------- |
| [zeldaret/oot](https://github.com/zeldaret/oot) | Matching decompilation of Ocarina of Time | C/C++ source only. "This repository does not include any of the assets necessary to build the ROM. A prior copy of the game is required to extract the needed assets." | Clean-room process (no leaked material, documented tooling), zero assets, user-supplied copy. |
| [Ship of Harkinian](https://github.com/HarbourMasters/Shipwright) (OoT PC port) | Native PC port built on the decomp + original `libultraship` code | Original code and binaries. "The Ship does not include any copyrighted assets. You are required to provide a supported copy of the game." | Assets are generated **locally** from the user's own ROM; strict no-piracy community policy. |
| [Zelda 64: Recompiled](https://github.com/Zelda64Recomp/Zelda64Recomp) | Static recompilation of Majora's Mask to native PC | Original tooling/runtime. "This repository and its releases do not contain game assets. The original game is required to build or run this project." | Recompilation runs against the user's own ROM at build/run time; everything else is original code. |
| [zeldaret/botw](https://github.com/zeldaret/botw) | Very early decompilation of BotW (Switch 1.5.0) | Source only. "This repository does not contain game assets or RomFS content and cannot be used to play Breath of the Wild." Also publishes a **names-only symbol database** (`data/uking_functions.csv`, 113k entries) for the same game version as our Wii U target — used here as vocabulary, fetched locally, never committed. | Same formula at a much larger scale; explicitly not a playable port. |
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

- zeldaret/botw targets the **Switch 1.5.0** decompilation and is in a very
  early stage; it is not playable and states "don't expect a port soon".
  It does publish a **names-only function database** for that build
  (`data/uking_functions.csv`, 113k entries) — the same game version as
  our Wii U v208 target. We use it as naming vocabulary only (fetched
  locally into a git-ignored folder) and copy no code from that project.
- The 2026 state of the art for this exact class of port is **static
  recompilation + native HLE**, demonstrated end-to-end on a Wii U Zelda
  title ([ZeldaWWHDRecomp](https://github.com/ZeldaWWHDRecomp/ZeldaWWHDRecomp))
  and informally on BotW itself (unreleased prototype, 2026). See
  [`docs/research/2026-10-prior-art-and-recompilation.md`](../research/2026-10-prior-art-and-recompilation.md).
- Our analysis targets the **Wii U** release (PowerPC), a different binary
  from the Switch build. We share the knowledge base of public formats
  (BYML, AAMP, SARC, BFRES, …) but copy nothing.
- BotW is orders of magnitude larger than the N64 titles. The realistic
  expectation for this project is incremental research milestones, not a
  finished port.
