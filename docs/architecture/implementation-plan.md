# BotW-PC stabilization and native port delivery plan

**Accepted architecture:** static PowerPC-to-C recompilation with original Cafe OS HLE and staged hybrid support, per [ADR-0002](decisions/0002-port-approach.md). This plan does not promise a playable release or replace the existing research.

## Phase 2A — CPU correctness gate (P0)

- [ ] Correct PPC-001..PPC-009 from [the code audit](../audits/2026-10-18-code-audit.md) with regression tests written first.
- [ ] Build independent differential oracle for synthetic PowerPC sequences and compare GPR/FPR raw bits, CR, LR, CTR, XER, guest memory and traps.
- [ ] Compile generated C in tests using the host C compiler; assert actual behavior beyond emitted text.
- [ ] Run tests automatically across supported Windows/Linux host toolchains and reject unsupported machine-code features explicitly.
- [ ] Publish metrics separately for decoded words, behaviorally verified instructions, compiled/reachable functions and actual HLE implementations.

**Exit:** all new synthetic regressions pass, original tests pass, and no known P0 semantics defect remains.

## Phase 2B — RPX loader, data relocations and Cafe OS

- [ ] Identify supported v208 source by cryptographic digest and version manifest (local input only).
- [ ] Map all allocated sections with validated ranges, .bss zero-fill, proper imports, relocations and data pointers.
- [ ] Replace raw pointer handling with checked region/address semantics and deterministic guest exceptions.
- [ ] Implement typed HLE registry with tested coreinit, proc_ui and minimum input/memory services; no silent success from unknown calls.
- [ ] Add synthetic headless boot fixture and trace logs with stable checkpoints.

**Exit:** reproducible synthetic RPX startup and stable first local boot checkpoint using user-owned inputs.

## Phase 2C — Scale and instrumentation

- [ ] Deterministic sharded generated C, linked guest function registry and content-addressed caches.
- [ ] Cross-check discovered function starts/indirect targets/jump tables against local Ghidra results.
- [ ] Add reference interpreter fallback only after copyright/license and correctness review.
- [ ] Implement guest scheduling/locking/time behavior needed by earliest boot path; fuzz malformed binary inputs.
- [ ] Measure runtime/host resident memory and compilation throughput; keep derived game output under ignored build/.

**Exit:** repeatable headless boot progress with strict unknown-call detection and measurable translation fidelity.

## Phase 3 — First light

- [ ] Enumerate GX2 boot imports, signatures and command dependencies.
- [ ] Synthetic framebuffer clear/present path, then command recording for genuine boot code.
- [ ] New ADR for Vulkan/Metal/OpenGL backend trade-offs and vendor licenses; validate shaders and textures separately.
- [ ] First reproducible on-screen frame without distributing game content.

**Exit:** visible synthetic frame and verified real-game-first-frame milestone only when actually observed.

## Phase 4+ (aspirational)

Asset parsers, scene streaming, physics, audio, input, saves, graphics fidelity, performance and playability; track each as independently verifiable milestone.

## Proposed incremental boundaries

- tools/rpxinfo: structurally safe RPX/RPL parsing
- tools/ppcx: decoder, control-flow analysis, translation, deterministic shard outputs
- src/runtime: checked guest memory, module loading, call dispatch, Cafe OS HLE, scheduler
- src/graphics: later GX2-to-native translation
- tests/isa and tests/loader: entirely synthetic conformance and negative tests
- .github/workflows: cross-platform CI without copyrighted game input
- docs/audits, docs/architecture and docs/research: source evidence, decisions, acceptance

## Contributor workflow

Write source, docs and commits in English; respond to the maintainer in Spanish. Record before/after evidence for fixes, update relevant README, ROADMAP, research and ADRs in the same PR. Do not mark a milestone complete from code alone. Review licenses for any dependency; GPL repos in the [comparative survey](../research/2026-10-native-port-patterns.md) are architecture references, not MIT source libraries.
