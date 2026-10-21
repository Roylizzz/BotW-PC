# tests/boot

Synthetic headless boot fixture: a game-free RPX authored byte by byte in
`fixture.js` runs through the **real** production path, from analysis to a
booted guest. No game data is required or produced.

## What it does

`run.js`:

1. builds the fixture RPX — ten functions (boot entry, helper, strict-mode
   entry, fault entry, pointer-only getter, split target, tail entry, switch
   entry, proc_ui lifecycle entry and data-import entry) plus an inline
   Metrowerks branch table with three `b` entries and three case bodies, the
   two `.fimport_*` sections (`coreinit.memcpy`, `coreinit.OSBlockMove`,
   `coreinit.OSSleepTicks` and all five `proc_ui` lifecycle imports) and a
   `.dimport_coreinit` section for `coreinit.__gh_FOPEN_MAX` and
   `coreinit._iob`, `.rodata` with three `R_PPC_ADDR32` pointers (one with an
   addend) and two applied TLS sites,
   `.data`, a NOBITS `.bss` and the allocated metadata trio;
2. runs the real `analyze` path and asserts the authored function starts,
   the pointer-only start, the cross-range tail start, the inline
   `tableStarts` and full decoder coverage;
3. emits C with the real `translateModule` used by `ppcx translate`
   (registry, `ppcx_entry`, import-name table), one unit per boot entry;
4. builds the load blob with the real `buildImage`/`serializeImage` path and
   checks the authored segment/byte/BSS facts, the applied `ADDR32` and TLS
   relocations and the code-relocation count;
5. compiles the generated unit with the real runtime
   (`ppcx_runtime.c`, `ppcx_mem.c`, `ppcx_hle.c`, `ppcx_image.c`) and a small
   generated driver (shared compiler discovery: `PPCX_CC`, then
   `cc`/`gcc`/`clang`/`tcc`);
6. boots ten scenarios headless and compares **every** stderr/stdout line
   with fixture-authored expectations, then runs the boot scenario again and
   requires byte-identical output.

## Scenarios and checkpoints

| Scenario | Entry | Expected |
| -------- | ----- | -------- |
| `boot` | boot | Exit 0. `PPCX_HLE_TRACE`/`PPCX_DISPATCH_TRACE` transcripts: entry dispatch, `coreinit.memcpy` (direct `bl`), trampoline dispatch `0x50000000`, `coreinit.OSBlockMove` (address-taken), `entry returned, r3 = 0x11223344`, two HLE calls. |
| `data` | data | Exit 0. Takes `__gh_FOPEN_MAX` with `addis` + `lhz` (the `ADDR16_LO` relocation is on the load displacement) and `_iob` with `addis` + `addi`; returns `20 + _iob[0].info = 0x18` and makes no HLE call. |
| `tolerant` | strict | Exit 0. Unmodeled `coreinit.OSSleepTicks` is a counted `[diagnostic no-op]`; r3 survives. |
| `strict` | strict | Exit 5. `unimplemented HLE … in strict mode` plus the register dump (r1/r3/lr exact). |
| `pointer` | pointer-only getter | Exit 0 with no HLE call, reached only through the `.rodata` code pointer. |
| `tail` | tail entry | Exit 0 with `r3 = 0x00000002`: the cross-range `b` enters the mid-body start *after* `addi r3,0,0x40`, and the generated unit contains `PPCX_TAILCALL(c, f_000100F0)`. Entering the split function from its top would leave `0x42`. |
| `switch` | switch entry | Exit 0 with `r3 = 0x00000011`: the computed `bctr` dispatches to the inline table entry at `0x1013C`, whose `b` reaches case 0. The trace shows `dispatch 0x00010118` then `dispatch 0x0001013C`; a `ppcx_bc(c,0,0)` gate would decrement CTR and dispatch `0x1013B` instead. |
| `procui` | proc_ui entry | Exit 0 with `r3 = 0x00000047`: seven modeled calls in order — `Init`, `RegisterCallback` (type 5), two `ProcessMessages(1)` returning 0, `DrawDoneRelease`, `Shutdown`, then a post-shutdown `ProcessMessages(1)` returning 3 (`EXITING`); the final `addi` turns 3 into `0x47`. |
| `fault` | fault | Exit 9. Read of 4 bytes at `0x01000000` (a hole between image and stack) with the register dump and empty stdout. |
| `no-image` | boot | Exit 9. Without `PPCX_IMAGE` the first data read at `0x00020100` faults instead of returning zeroes. |

After a successful boot the driver prints the guest-memory probes
(`checkpoint <name>=<value>`): the three applied `.rodata` pointers, the
resolved TLS index (`module = 1`, `offset = 4`), the GHS data values
(`__gh_FOPEN_MAX = 20`, `_iob[0..2].info` = `4`, `0x00040002`,
`0x00080002`), the `.data` words and the two copied words in `.bss`
(`memcpy` and the trampoline `OSBlockMove`). The `tolerant` and `pointer`
scenarios assert the untouched initial values, so a stray write cannot pass
unnoticed.

Expected output:

```
boot: 10 scenarios (8 entries compiled), 54 transcript lines, 112 memory probe lines, compiled with <compiler>
boot: OK, the synthetic RPX boots headless with stable checkpoints
```

The reference unit translates 16 functions (133 instructions): the authored
scenario entries (boot, strict, fault, pointer, tail, switch, proc_ui and
data), the helper called by the boot entry, the mid-body tail target, the
three inline table entries and the three switch case bodies. The table
entries are emitted as explicit roots because the translator's static callee
walk cannot see a computed `bctr` target.

## What it gates

The fixture found four real defects, all fixed and covered here:

* address-taken imports were absent from the generated `ppcx_import_name`
  table (only REL24 call sites were recorded), so a call through the
  dispatcher trampoline reported `unknown-import` and silently no-opped;
  `translateFunction` now reports `importAddrs` and `translateModule` unions
  them into the name table and the report;
* the initial SP sat at the top of the mapped stack, so the loader's ABI
  frame was outside the region and the first standard prologue faulted on
  its LR save; `ppcx_run` now starts 16 bytes below the top, inside the
  stack;
* data imports were routed to the function trampoline, and the
  `__gh_FOPEN_MAX` low-half relocation on `lhz` was not applied; the
  translator now records the import kind, emits `PPCX_IMPORT_DATA_ADDR`, and
  patches D-form load displacements. The `data` scenario returns `0x18` only
  when both fixes are present.

The first two were confirmed by mutation before being accepted: reverting the
frame produced 10 failing expectations and changing one authored data word
produced 4, each with the exact differing transcript/probe lines. The tail
scenario gates the cross-range start fixpoint the same way: run against the
analyzer from before the fix, the harness reports 14 failing expectations,
including the real runtime failure `branch or call to an address with no
registered function (0x000100F0)` and exit 4.

The switch scenario gates the `tableStarts` class end to end and found a
third defect: canonical `blr`/`bctr` did not report `BO`/`BI`, so the
translator emitted `if (ppcx_bc(c, 0, 0))` before `PPCX_DISPATCH`. `BO = 0`
means “decrement CTR and branch if nonzero”, so the gate decremented CTR and
the dispatch landed one word below the table entry (`0x1013B` instead of
`0x1013C`); the scenario failed with the runtime's unregistered-address
diagnostic. The decoder now returns `bo: 20, bi: 0`, the emitted code is a
bare dispatch, and a translate test asserts that no `ppcx_bc` call appears.

The `procui` scenario gates the five exact-name lifecycle models through the
same REL24 substitution as the real module: `ProcUIInit` with a non-NULL save
callback, one `ProcUIRegisterCallback`, two foreground `ProcessMessages`
pumps around `ProcUIDrawDoneRelease`, `ProcUIShutdown`, and a post-shutdown
pump that must report `EXITING` (3). The returned `0x47` proves the status,
not just a successful call; the native contract test additionally checks the
recorded callback fields, the bounded table, reset/re-init and register
preservation.

The `data` scenario gates the GHS data-import model (ADR-0006). A data import
must resolve to storage through `PPCX_IMPORT_DATA_ADDR`, never to the
`0x50000000 + index * 8` function trampoline, and the `addis` + `lhz` site
proves that `R_PPC_ADDR16_LO` is applied to D-form load displacements, not
only to `addi`. Reverting either rule makes the entry read an invalid address
and the boot fails with a guest-memory fault instead of `r3 = 0x18`; the
post-run probes also check the modeled `_iob` words.

The input models are deliberately not part of this synthetic fixture:
`tests/hle` covers all 18 natively on a raw arena, and the real v208 wrappers
at `0x030C7558` (`WPADProbe`) and `0x030D730C` (headphone status) cover the
REL24 substitution and dispatcher path for the modeled services. Adding an
input scenario here would duplicate that coverage without a new contract.

## Running

```sh
node tests/boot/run.js                 # CLI, exits non-zero on mismatch
node --test "tests/boot/*.test.js"     # node:test wrapper (skips without a compiler)
```

The synthetic boot harness runs in the `compiled-conformance` GitHub Actions
job with `PPCX_CC=cc`; the workflow is **manual-only** and is dispatched from
the Actions tab. CI rejects mismatched checkpoints and a nonzero exit; no
Nintendo data is used or uploaded.

See `docs/research/2026-10-recompiler-prototype.md` for the findings and
`src/runtime/README.md` for the stack frame and HLE details.
