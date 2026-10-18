# Static recompilation engineering audit (2026-10-18)

**Baseline:** main at 9f63ee39c656bfd3f1e906827d4ae6830d2fda3c. **Scope:** source inspection and test review, not a full runtime/game execution. Findings below are source-level defects or implementation gaps and need synthetic regression tests before being marked closed.

| ID | Severity | Location | Observation | Acceptance |
|---|---|---|---|---|
| PPC-001 | P0 | src/runtime/include/ppcx_abi.h:ppcx_mask_mb_me | PowerPC MSB-indexed masks are incorrectly generated. MB=0, ME=0 currently produces 0x00000001 instead of 0x80000000 | All 1,024 MB/ME pairs checked against independent oracle |
| PPC-002 | P0 | ppcx_abi.h:ppcx_lswi,ppcx_stswi | Register advances for each byte instead of every group of four | NB=0,1,4,5,8,32 and r31 wrapping validated |
| PPC-003 | P0 | tools/ppcx/lib/decode.js, translate.js | Opcode-16 conditional branch omits LK and translator cannot correctly implement bcl | LR updates when LK=1 (including untaken branch); correct call/return flow |
| PPC-004 | P0 | tools/ppcx/lib/translate.js | rcExpr causes CR0 updates after register arithmetic/logical operations even if Rc=0 | Plain operations preserve CR0; dotted variants update it |
| PPC-005 | P0 | translate.js | mulli immediate is emitted as unsigned 16-bit | Negative multiplier semantic execution test |
| PPC-006 | P0 | translate.js | cmpli uses signed immediate instead of zero-extended 16-bit field | Compare values 0x7FFF,0x8000,0xFFFF |
| PPC-007 | P0 | translate.js | addic/subfic/cmpi/cmpli substitute literal 0 for RA=0 where they must read r0 (unlike addi/addis) | r0 nonzero synthetic tests for each opcode |
| PPC-008 | P0 | decode.js, translate.js | lwsync decodes as supported, but no translator case is emitted | Generates correct memory fence; compiled test |
| PPC-009 | P1 | ppcx_abi.h:ppcx_neg | neg helper modifies XER.CA improperly | CA unaffected by neg; OE handling independently validated |
| RUN-001 | P0 | src/runtime/src/ppcx_runtime.c | All HLE imports currently return with CPU unchanged | Typed HLE registry, strict unknown-import failure, OS models |
| RUN-002 | P0 | tools/ppcx / runtime | Missing loaded .rodata/.data/.bss image and applied data relocations | Synthetic loaded sections and relocation fixtures |
| RUN-003 | P1 | ppcx_abi.h:ppcx_ptr | Unchecked raw host pointer arithmetic and approximately 3.03-GiB flat guest arena | Checked address/permissions, predictable guest fault |
| RUN-004 | P1 | ppcx ABI | FPSCR, GQR quantization, floating estimates, reservation/multicore semantics approximated | Family-specific differential tests and documented status |
| RUN-005 | P1 | tools/ppcx/ppcx.js:loadOrComputeAnalysis | Cache keyed only by analysis schema/base/size, not input digest | Digest verified with source image |
| RUN-006 | P1 | tools/ppcx/ppcx.js:cmdTranslate | Monolithic gen.c at large scale, heuristic function range splits | Sharded deterministic compiler with CFG confidence evidence |
| RUN-007 | P1 | GitHub repo metadata | No workflow runs, releases or protection on main at review time | Add CI and required checks; then protect branch |
| RUN-008 | P2 | docs/architecture/README.md | Claims port strategy undecided although ADR-0002 was accepted | Sync with actual decision |

**Tests:** Source declares 75 JS test cases across ppcx and rpxinfo. Many translation tests assert strings rather than compiling and running emitted code. Tests were inspected, not executed for this audit. No claim about entire suite passing.

**Published metrics:** The research note reports around 97% decoder coverage on a contributor-local v208 RPX plus one compiled demonstration reaching a traced proc_ui HLE call. These do NOT imply playable game, 97% instruction semantic equivalence, working Cafe OS, or graphics.

## Fix verification protocol

1. Add a failing synthetic test for every confirmed defect before touching translator/runtime.
2. Compare actual CPU GPR/FPR/CR/XER/LR/CTR plus guest memory to an independently reviewed PowerPC oracle, including signed extremes, zero, carry, bit-mask wrap, Rc and LK.
3. Compile emitted C with a real host compiler and run it; do not rely on generated-string assertions alone.
4. Run existing npm tests and host compile/sanitizers as supported; record observed pass/fail count, tool versions and commands.
5. Test safe failure on out-of-bounds memory, unknown relocations, unsupported imports and truncated RPX files.
6. Run actual game tests only locally with contributor-owned game files. Never upload generated C, disassembly, assets, dumps or keys.

See [port survey](../research/2026-10-native-port-patterns.md) and [implementation plan](../architecture/implementation-plan.md).
