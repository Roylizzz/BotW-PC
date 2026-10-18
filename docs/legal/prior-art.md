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
| [zeldaret/botw](https://github.com/zeldaret/botw) | Very early decompilation of BotW (Switch 1.5.0) | Source only. "This repository does not contain game assets or RomFS content and cannot be used to play Breath of the Wild." | Same formula at a much larger scale; explicitly not a playable port. |
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
- Our analysis targets the **Wii U** release (PowerPC), a different binary
  from the Switch build. We share the knowledge base of public formats
  (BYML, AAMP, SARC, BFRES, …) but copy nothing.
- BotW is orders of magnitude larger than the N64 titles. The realistic
  expectation for this project is incremental research milestones, not a
  finished port.
