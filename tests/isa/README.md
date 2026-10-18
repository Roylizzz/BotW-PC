# tests/isa — differential ISA harness

Decode coverage is not semantic correctness. This directory verifies that the
C code emitted by `tools/ppcx` behaves like the instruction set it claims to
implement, by running the same guest programs twice:

1. through the **generated C**, compiled by a real host compiler and executed;
2. through an **independent reference model** (`oracle.js`) that shares no code
   with the decoder or the runtime helpers.

Both sides must produce an identical final machine state — all 32 GPRs, XER
(including OV/SO/CA), CR, LR, CTR and every declared memory window. Any
difference fails the run with a line-by-line report.

## Layout

| File | Purpose |
| --- | --- |
| `oracle.js` | Independent decoder/interpreter for the integer core. Written from the ISA plus the behaviour of two reference implementations (the reference PowerPC emulator used during development and a second, independent emulator) for the behaviour the ISA leaves undefined: divide-by-zero results, OV/SO accumulation, `lswi`/`stswi` partial groups. |
| `cases.js` | The program corpus: one basic block per case, terminated by `blr`, with initial registers/memory and optional memory dumps. |
| `run.js` | Driver: translates every case, generates one C harness, compiles it, runs it and compares against the oracle. Exit code 0 on match, 1 on mismatch. |
| `isa.test.js` | `node:test` wrapper: an always-on rotate-mask sweep (all 1024 MB/ME pairs) plus the compiled comparisons, each skipped with a message when no compiler is present. |

## Running

```sh
node tests/isa/run.js            # differential run, non-zero exit on mismatch
node --test tests/isa/isa.test.js
```

Compiler discovery, in order: `PPCX_CC`, `cc`, `gcc`, `clang`, `tcc` on PATH,
then the usual TCC install locations on Windows. Without a compiler the
`node:test` wrapper skips the compiled tests; CI installs one.

## Scope and limitations

- The oracle models a **single basic block** ending in `blr`; branches,
  exceptions and system state are out of scope.
- Floating point is **not** modelled here (it is covered separately).
- `lwarx`/`stwcx.` use a first-iteration reservation model, matching the
  single-threaded scope of the runtime prototype.
- Memory is a flat 256 KiB arena (`ARENA`); the harness allocates the same.

These limitations are deliberate: this harness pins integer semantics. Runtime
and HLE behaviour are covered by the runtime tests, and the recompiler's
control-flow lowering by `tools/ppcx/tests/translate.test.js`.

## Evidence discipline

A fix is only trusted when the harness **fails without it**. During the
2026-10 audit every defect class in `docs/audits/2026-10-18-code-audit.md`
(PPC-001 … PPC-013) was re-introduced in a child process
(`build/audit/mutation-check.js`, local and git-ignored) and every mutation
produced mismatches — including two defects found by extending this corpus:
post-store operand aliasing in the OE forms (PPC-012) and the `neg` OE
overflow value (PPC-013).

## Out-of-tree content

Nothing game-derived is stored here: the cases are synthetic snippets written
for the harness. The game binary is never compiled or committed.
