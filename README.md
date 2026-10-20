# BotW-PC

An open, **clean-room** research project studying *The Legend of Zelda: Breath
of the Wild* — with the long-term goal of running it natively on PC.

> **Status: Phase 2 — feasibility signed off (ADR-0002); prototype in
> progress.** The analysis environment is in place (REA + direct Ghidra
> headless), the RPX format is documented, and the prototype
> (`tools/ppcx` + `src/runtime`) translates and runs real functions from a
> contributor's own copy. The 2026-10-18 audit fixed PPC-001…PPC-013 and
> re-verified them with a compiled differential harness. The 2026-10-19
> follow-ups add the RPX load image (all allocated sections, `.bss`
> zero-fill and 278,749 data relocations) with a runtime loader that
> validates bounds, ordering and a payload checksum before mapping, a
> checked guest-memory model (stack + loaded segments; anything else faults
> deterministically with exit code 9 instead of reading unrelated bytes),
> a minimal exact-name HLE registry for 40 calls — 17 coreinit identity,
> flat-memory/cache, clock and system-info services, the 5 proc_ui lifecycle
> functions and 18 headless input calls — with
> strict unknown-call handling, and a
> synthetic headless boot fixture (`tests/boot`) that runs a game-free RPX
> through the whole pipeline with stable trace and memory checkpoints. See
> [ROADMAP.md](ROADMAP.md).

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
| `tools/` | Original CLI tools: `tools/rpxinfo` (RPX/RPL inspector) and `tools/ppcx` (PowerPC → C recompiler prototype) |
| `src/` | Original runtime code (`src/runtime`: memory model, dispatch, HLE layer) |

## Engineering review and current development gates

- [Modern native-port comparison](docs/research/2026-10-native-port-patterns.md)
- [2026-10-18 correctness audit](docs/audits/2026-10-18-code-audit.md)
- [Stabilization/implementation plan](docs/architecture/implementation-plan.md)
- [REA and direct Ghidra guidance](docs/reverse-engineering/rea-guidance.md)

The corrected decoder covers **99.9994%** of the module's words (9,248,462 of 9,248,515; no known-unsupported instructions, 53 unknown/data words), the audit defects are mutation-verified, the quantized paired-single loads/stores are differentially tested and an independent rizin disassembly of all 9,248,515 words agrees mnemonic by mnemonic with the decoder (zero real disagreements, 53 data/illegal words rejected by both) — coverage is still **not** behavioral correctness or game compatibility. The prototype does not boot a playable game; the section/data image now loads and maps under bounds/order/checksum checks and guest accesses outside the mapped regions (stack + loaded segments) fault deterministically, while loaded segments also carry their ELF write permission so writes to `.text` or the import tables stop with exit code 9; a game-free RPX boots end to end through the real pipeline with stable trace and memory checkpoints (`tests/boot`); the rest of Cafe OS (only 40 exact-name calls are modeled: coreinit identity/memory/cache, the deterministic virtual clock and system-info services, the proc_ui lifecycle and 18 headless input calls) and GPU presentation are unfinished (Phase 2B/2C of the implementation plan).

## Legal

*The Legend of Zelda* and *Breath of the Wild* are trademarks of Nintendo.
This project claims no rights over them and is not affiliated with Nintendo.
See [DISCLAIMER.md](DISCLAIMER.md).

## License

Original code in this repository is licensed under the MIT License —
see [LICENSE](LICENSE).
