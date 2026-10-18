# BotW-PC

An open, **clean-room** research project studying *The Legend of Zelda: Breath
of the Wild* — with the long-term goal of running it natively on PC.

> **Status: Phase 0 — legal groundwork and project organization.**
> No runtime code yet. See [ROADMAP.md](ROADMAP.md).

## What this project is

BotW-PC is a community research effort that studies the game's observable
behavior and file formats using **legally obtained, user-owned copies**, and
builds **original** tooling and runtime code on top of publicly available
knowledge.

## What this project is *not*

- ❌ It does **not** include, host, or distribute any Nintendo game code,
  assets, encryption keys, or game files.
- ❌ It does **not** help you obtain a copy of the game. There is no piracy here.
- ❌ It does **not** circumvent DRM or any technological protection measure.
- ❌ It is **not** affiliated with, endorsed by, or sponsored by Nintendo.

## How it works (the clean-room rule)

Everything in this repository is written from scratch. Findings are recorded
as **notes, offsets, and format documentation** produced by analyzing a
contributor's *own legally acquired copy*. Verbatim disassembly/decompiler
output, extracted assets, and keys never enter this repo.

Read the full policy: [DISCLAIMER.md](DISCLAIMER.md) and
[docs/legal/clean-room-policy.md](docs/legal/clean-room-policy.md).

## Requirements (for contributors)

- Your own legally purchased copy of the game (Wii U and/or Switch).
- [REA](https://github.com/morluto/rea) — the reverse-engineering toolkit used
  for analysis (local-only, MIT licensed). See
  [docs/reverse-engineering/README.md](docs/reverse-engineering/README.md).
- Optional: Ghidra (PowerPC support) or IDA for deep binary analysis.

## Repository layout

| Path | Purpose |
| ---- | ------- |
| `docs/legal/` | Clean-room policy and legal rules |
| `docs/research/` | Findings from analysis of contributors' own copies |
| `docs/reverse-engineering/` | Tooling and workflow docs (REA, Ghidra, …) |
| `docs/architecture/` | Architecture sketch and decision records (ADRs) |
| `tools/` | Original CLI tools — first one: `tools/rpxinfo` (RPX/RPL inspector) |
| `src/` *(planned)* | Original runtime code |

## Legal

*The Legend of Zelda* and *Breath of the Wild* are trademarks of Nintendo.
This project claims no rights over them and is not affiliated with Nintendo.
See [DISCLAIMER.md](DISCLAIMER.md).

## License

Original code in this repository is licensed under the MIT License —
see [LICENSE](LICENSE).
