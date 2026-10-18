# Roadmap

> **Real talk:** a complete native PC port of *Breath of the Wild* is a
> multi-year, multi-disciplinary effort far beyond any emulator shortcut.
> This roadmap is honest about that and focuses on **legal, incremental,
> verifiable steps** — with no promise of a finish line.

## Guiding principles

1. **Legal safety first:** zero Nintendo content in the repository.
2. **Working software over big plans:** every milestone produces something
   runnable.
3. **Reproducible:** everything must work from a user's own copy + this repo.

## Phase 0 — Project organization ✅ (in progress)

- Clean-room policy, disclaimer, license.
- Repository structure and contribution rules.

## Phase 1 — Analysis environment & reconnaissance

- [ ] Set up the REA toolchain (Node 22.19+/24.11+/26+) and a deep-analysis
      provider (Ghidra with PowerPC support, or IDA).
- [ ] Inventory a contributor's own copy: file layout (`content/`, `romfs/`,
      update/DLC), executable identification (main RPX on Wii U / main NSO on
      Switch).
- [ ] Format notes: boot flow and resource formats (BYML, AAMP, SARC, BFRES,
      …) documented from public knowledge plus own observations.

Deliverable: `docs/research/` notes and format specs.

## Phase 2 — Feasibility & architecture decision

- [ ] Evaluate directions:
  - **A. Recompilation-style:** translate the original binary into native
    code that runs against the user's own data. Technically enormous; prior
    art exists for other N64-era titles.
  - **B. Engine reimplementation:** original engine code that interprets the
    user's data files. Years of work; asset formats are the entry point.
  - **C. Assisted emulation:** original helper tooling around an existing
    emulator experience. Least effort; not a real "port".
- [ ] Write an ADR choosing the direction, with reasoning.

Deliverable: `docs/architecture/` decision record.

## Phase 3 — First light

- [ ] A minimal original runtime that loads a user's own data and renders
      *something* (e.g., a single terrain tile or a model the user extracted
      locally).

Deliverable: `tools/` prototype + demo instructions (no assets in repo).

## Phase 4+ — Long-term goals (aspirational)

- Boot flow, world streaming, rendering, physics, UI, audio…
- Every area gated by: legal safety, reproducibility, community review.
