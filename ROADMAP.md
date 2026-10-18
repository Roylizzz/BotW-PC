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

## Phase 0 — Project organization ✅ (done)

- Clean-room policy, disclaimer, license.
- Repository structure and contribution rules.

## Phase 1 — Analysis environment & reconnaissance

- [x] Set up the REA toolchain (Node 24, REA 6.5.0) and a deep-analysis
      provider (Ghidra 12.1.4 with a PowerPC/RPX loader; see
      `docs/reverse-engineering/environment.md`).
- [x] Inventory a contributor's own copy: file layout (`content/`, update
      data), executable identification (`code/U-King.rpx`, base + v208).
- [ ] Format notes: boot flow and resource formats (BYML, AAMP, SARC, BFRES,
      …) documented from public knowledge plus own observations.
      *(RPX/RPL documented in `docs/research/`; asset formats pending.)*
- [x] Deep-analysis database of the executable (Ghidra census:
      [`docs/research/2026-10-ghidra-census.md`](docs/research/2026-10-ghidra-census.md)).

Deliverable: `docs/research/` notes and format specs.

## Phase 2 — Feasibility & architecture decision

- [x] Evaluate directions against 2026 prior art
      ([reconnaissance](docs/research/2026-10-prior-art-and-recompilation.md)):
  - **A. Recompilation-style:** translate the original binary into native
    code that runs against the user's own data. **Close, working precedents
    exist on Wii U** (ZeldaWWHDRecomp; general toolkit in nWiiURecomp) plus
    a private BotW prototype; ADR-0002 records a recommendation for this
    direction.
  - **B. Engine reimplementation:** original engine code that interprets the
    user's data files. Years of work; remains the long-term convergence path
    via `zeldaret/botw` (Switch 1.5.0 — same game version as our v208).
  - **C. Assisted emulation:** original helper tooling around an existing
    emulator experience. Least effort; not a real "port" — excluded.
- [x] Naming material identified: names-only function/symbol database for
      the same game version — `tools/fetch-symbol-data.ps1` (local, never
      committed).
- [x] Maintainer sign-off on the recommended direction — ADR-0002 accepted
      2026-10-18 (option A — static recompilation + HLE runtime — structured
      as option D in time).
- [ ] First workstreams (started — the prototype already translates and runs
      an end-to-end function; see
      `docs/research/2026-10-recompiler-prototype.md`):
  - recompiler pass over our own RPX (boundaries from the Ghidra census +
    `tools/rpxinfo` relocations; big-endian memory model; tail calls;
    indirect-call dispatch);
  - HLE runtime skeleton for the **437 mapped imports** (start with
    `coreinit`/`proc_ui`, keep GX2 stubbed);
  - GX2 "first frame" milestone: implement the `gx2` imports used before
    the first present (call-site map already exists in Phase 1 notes).

Deliverable: `docs/architecture/` decision record.

## Phase 2 stabilization gate — mandatory before first light

- [ ] Resolve source-level PowerPC semantic defects PPC-001..PPC-009, each with a failing synthetic regression first.
- [ ] Compile and execute generated C against a separate reference oracle; measure state/memory correctness, not only opcode decode counts.
- [ ] Implement authenticated RPX section/data image, relocation handling, memory checks and typed, non-silent Cafe OS HLE.
- [ ] Establish deterministic headless boot checkpoints, content-addressed analysis caches and scalable generated-C shards.
- [ ] Configure PR CI and test on local, user-owned dumps without uploading derived Nintendo code.

See the [audit](docs/audits/2026-10-18-code-audit.md), [implementation plan](docs/architecture/implementation-plan.md), and [comparative research](docs/research/2026-10-native-port-patterns.md).

## Phase 3 — First light

- [ ] A minimal original runtime that loads a user's own data and renders
      *something* (e.g., a single terrain tile or a model the user extracted
      locally).

Deliverable: `tools/` prototype + demo instructions (no assets in repo).

## Phase 4+ — Long-term goals (aspirational)

- Boot flow, world streaming, rendering, physics, UI, audio…
- Every area gated by: legal safety, reproducibility, community review.
