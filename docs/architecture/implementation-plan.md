# BotW-PC stabilization and native port delivery plan

**Accepted architecture:** static PowerPC-to-C recompilation with original Cafe OS HLE and staged hybrid support, per [ADR-0002](decisions/0002-port-approach.md). This plan does not promise a playable release or replace the existing research.

## Phase 2A — CPU correctness gate (P0)

- [x] Correct PPC-001..PPC-013 from [the code audit](../audits/2026-10-18-code-audit.md) with regression tests written first (10/10 mutations detected — see the audit's fix verification results).
- [ ] Build independent differential oracle for synthetic PowerPC sequences and compare GPR/FPR raw bits, CR, LR, CTR, XER, guest memory and traps. *(Implemented: the integer core and the quantized paired-single load/store path compare GPR/XER(OV/SO/CA)/CR/LR/CTR, raw-bit FPR lanes, GQR/HID2 and memory windows over 221 compiled programs; FP arithmetic and trap conditions remain open.)*
- [x] Compile generated C in tests using the host C compiler; assert actual behavior beyond emitted text (TCC locally; the compiled ISA/loader/memory/boot harnesses run in the manually dispatched CI).
- [ ] Run tests automatically across supported Windows/Linux host toolchains and reject unsupported machine-code features explicitly. *(Started: manually dispatched CI runs the JS suites on Linux with Node 22/24 plus the compiled ISA/loader/memory/boot conformance and the HLE contract test; Windows is verified locally; unsupported machine code stops with `PPCX_UNIMPL`.)*
- [ ] Publish metrics separately for decoded words, behaviorally verified instructions, compiled/reachable functions and actual HLE implementations. *(Started: decoded-word coverage, the compiled harness and the HLE models are reported separately (18 exact-name calls today: 13 coreinit identity/memory/cache and 5 proc_ui lifecycle); "verified" currently means harness coverage, not the whole module.)*

**Exit:** all new synthetic regressions pass, original tests pass, and no known P0 semantics defect remains.

## Phase 2B — RPX loader, data relocations and Cafe OS

- [ ] Identify supported v208 source by cryptographic digest and version manifest (local input only). *(v208 SHA-256 recorded in [environment.md](../reverse-engineering/environment.md) and re-verified 2026-10-19 by an `image` run with the recorded digest; `ppcx image --expect-sha256 <digest>` pins it. Version manifest still open.)*
- [ ] Map all allocated sections with validated ranges, .bss zero-fill, proper imports, relocations and data pointers. *(Implemented 2026-10-19 except documented deferrals: `node tools/ppcx/ppcx.js image --rpx …` validates 31 allocated sections of v208 (43,155,811 bytes including 1,399,469 of `.bss`), applies the 278,749 `R_PPC_ADDR32` data relocations, leaves 889,935 executable-section sites to the recompiler and records the 6 TLS (`DTPMOD32`/`DTPREL32`) sites explicitly; the runtime maps the blob under bounds/order/checksum checks. Synthetic golden fixtures plus 10 corrupted-blob classes in `tests/loader`. Data slots that point into import slots are not observed in v208 and stay unmodelled.)*
- [x] Replace raw pointer handling with checked region/address semantics and deterministic guest exceptions. *(Implemented 2026-10-19 — RUN-003: `src/runtime/src/ppcx_mem.c` keeps a region map (stack + every loaded segment) behind all accessors in `ppcx_abi.h`; an access outside every region prints one deterministic diagnostic plus the register context and exits with code 9, and the loader registers segments before mapping anything (exit -10 on overlap or a full table). The blob carries the ELF writable bit (`SHF_WRITE`), so a write to a read-only segment faults with its own deterministic diagnostic and exit 9; on v208, 5 segments are writable and 26 read-only. Executable permission is not enforced because translated code is native C and never fetches guest bytes. Covered by the compiled harness in `tests/mem` and checked/permission probes plus a read-only write in `tests/loader`.)*
- [ ] Implement typed HLE registry with tested coreinit, proc_ui and minimum input/memory services; no silent success from unknown calls. *(Started 2026-10-19: exact-name coreinit registry — the four identity calls (`OSGetCoreCount`, `OSGetCoreId`, `OSGetMainCoreId`, `OSIsMainCore`) and nine flat-memory/cache primitives (`OSBlockMove`, `OSBlockSet`, `memcpy`, `memset`, `DCZeroRange`, `DCFlushRange`, `DCFlushRangeNoSync`, `DCInvalidateRange`, `OSMemoryBarrier`) with strict unknown-call failure (`PPCX_HLE_STRICT=1`, exit code 5), a native contract test in `tests/hle` and 25 positive plus 4 fault HLE cases under the real region map in `tests/mem`. 2026-10-20: the five imported proc_ui lifecycle calls (`ProcUIInit`, `ProcUIProcessMessages`, `ProcUIDrawDoneRelease`, `ProcUIRegisterCallback`, `ProcUIShutdown`) are modeled with a deterministic headless state machine, a bounded callback record that is never invoked, and a ninth boot scenario that proves the post-shutdown `EXITING` status. Input, filesystem and threading services remain open.)*
- [x] Add synthetic headless boot fixture and trace logs with stable checkpoints. *(Implemented 2026-10-19: `tests/boot` authors a game-free RPX (nine functions plus an inline three-entry `b`-table, eight imports, three relocated `.rodata` pointers, two deferred TLS sites, `.data`/`.bss` and the allocated metadata trio) and runs it through the whole production path — real `analyze`, the real `translateModule` emission, `buildImage`/`serializeImage`, then the real runtime + checked memory + HLE compiled and booted headless. Nine scenarios compare every stderr/stdout line with authored expectations: boot with a direct `bl` HLE call and an address-taken import through the dispatcher trampoline (traces at `PPCX_HLE_TRACE=1`/`PPCX_DISPATCH_TRACE=1`), an unmodeled import tolerated as a counted diagnostic no-op, `PPCX_HLE_STRICT=1` stopping with exit 5, a pointer-only getter reached through a `.rodata` code pointer, a cross-range tail `b` that executes the mid-body start the analysis fixpoint discovered (`PPCX_TAILCALL(c, f_000100F0)`, `r3 = 2` only when the jump skips `addi r3,0,0x40`), a computed `bctr` inline-table switch that dispatches to `0x1013C` and returns `r3 = 0x11`, the five modeled proc_ui lifecycle calls with a post-shutdown `EXITING` status (`r3 = 0x47`), an unmapped read (exit 9) and the same boot without `PPCX_IMAGE` faulting at the first data read instead of reading zeroes. Guest-memory probes assert the applied relocations, the untouched TLS bytes and the writes the two copied words leave in `.data`/`.bss`; the boot scenario must repeat byte-identically. The fixture found and gated three real defects: address-taken imports were missing from `ppcx_import_name` (the dispatcher reported `unknown-import` for them), the initial SP left no room for the loader's ABI frame, so the first real prologue faulted, and canonical `blr`/`bctr` omitted `BO`/`BI` so the translator's `ppcx_bc(c,0,0)` gate decremented CTR and shifted the switch target by one word. The tail scenario adds a mutation gate: the pre-fixpoint analyzer produces 14 failing expectations, including the runtime exit 4 at `0x000100F0`. `node tests/boot/run.js`.)*

**Exit:** reproducible synthetic RPX startup and stable first local boot checkpoint using user-owned inputs. *(Synthetic half met 2026-10-19 with `tests/boot`; the user-owned-input half stays open until a real v208 boot path reaches a stable modelled checkpoint beyond the single `FUN_031FA4CC` graph method, which now runs its modeled `proc_ui.ProcUIInit` and returns with strict exit 0.)*

## Phase 2C — Scale and instrumentation

- [ ] Deterministic sharded generated C, linked guest function registry and content-addressed caches.
- [ ] Cross-check discovered function starts/indirect targets/jump tables against local Ghidra results. *(Decode cross-check landed 2026-10-19: all 9,248,515 words compared against a rizin dump through `tools/ppcx/xcheck.js` — zero real disagreements, 53 data/illegal words rejected by both sides. Function-start census comparison landed 2026-10-19: 96,052 of 96,874 branch starts agree with the census and both difference classes are classified and sampled — 779 Ghidra-only in-`.text` entries (362 tail-`b` targets our discovery skips plus 417 others) and 822 ours-only starts (498 `bl` targets, 324 prologues) in regions where the census has no function at all, so it is a lower bound, not a completeness reference. The pointer scan now also reads `.rela.data` (landed 2026-10-19: 139,005 total targets, 104,499 extra starts). Inline jump tables landed 2026-10-20: the five-class indirect audit classified all 5,671 `bctr` sites, and the exact Metrowerks shape (`addis`/`addic` base + scaled index + `add` + `mtctr` + `bctr`) identifies **177 tables with 2,986 `b` entries** (all at `bctr + 4`; 2,979 case targets had no other static edge). They form a separate `tableStarts` class (`ANALYSIS_VERSION` 9), are unioned into the translation ranges and seed the cross-range fixpoint, which now adds 3,275 tail starts, for a **207,634-range union**; the 828,267-pair invariant re-check leaves zero dispatch gaps (27,798 start hits, 800,469 intra-range). The boot fixture gates the class with a `switch` scenario and found a real `bctr` defect (missing `BO`/`BI` caused a CTR-decrementing dispatch gate; fixed and regression-tested). Remaining: vtable/register-indirect edges are resolved at run time by the dispatcher by design, and the 68 zeroed runtime tables plus cross-module targets stay out of static scope.)*
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
