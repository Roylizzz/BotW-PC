# tests/boot

Synthetic headless boot fixture: a game-free RPX authored byte by byte in
`fixture.js` runs through the **real** production path, from analysis to a
booted guest. No game data is required or produced.

## What it does

`run.js`:

1. builds the fixture RPX — seven functions (boot entry, helper, strict-mode
   entry, fault entry, pointer-only getter, split target and a tail entry),
   two `.fimport_*` sections with `coreinit.memcpy`, `coreinit.OSBlockMove`
   and `proc_ui.ProcUIInit`, `.rodata` with three `R_PPC_ADDR32` pointers
   (one with an addend) and two deferred TLS sites, `.data`, a NOBITS `.bss`
   and the allocated metadata trio;
2. runs the real `analyze` path and asserts the authored function starts,
   the pointer-only start, the cross-range tail start and full decoder
   coverage;
3. emits C with the real `translateModule` used by `ppcx translate`
   (registry, `ppcx_entry`, import-name table), one unit per boot entry;
4. builds the load blob with the real `buildImage`/`serializeImage` path and
   checks the authored segment/byte/BSS facts, the applied `ADDR32`
   relocations, the deferred TLS sites and the code-relocation count;
5. compiles the generated unit with the real runtime
   (`ppcx_runtime.c`, `ppcx_mem.c`, `ppcx_hle.c`, `ppcx_image.c`) and a small
   generated driver (shared compiler discovery: `PPCX_CC`, then
   `cc`/`gcc`/`clang`/`tcc`);
6. boots seven scenarios headless and compares **every** stderr/stdout line
   with fixture-authored expectations, then runs the boot scenario again and
   requires byte-identical output.

## Scenarios and checkpoints

| Scenario | Entry | Expected |
| -------- | ----- | -------- |
| `boot` | boot | Exit 0. `PPCX_HLE_TRACE`/`PPCX_DISPATCH_TRACE` transcripts: entry dispatch, `coreinit.memcpy` (direct `bl`), trampoline dispatch `0x50000000`, `coreinit.OSBlockMove` (address-taken), `entry returned, r3 = 0x11223344`, two HLE calls. |
| `tolerant` | strict | Exit 0. Unmodeled `proc_ui.ProcUIInit` is a counted `[diagnostic no-op]`; r3 survives. |
| `strict` | strict | Exit 5. `unimplemented HLE … in strict mode` plus the register dump (r1/r3/lr exact). |
| `pointer` | pointer-only getter | Exit 0 with no HLE call, reached only through the `.rodata` code pointer. |
| `tail` | tail entry | Exit 0 with `r3 = 0x00000002`: the cross-range `b` enters the mid-body start *after* `addi r3,0,0x40`, and the generated unit contains `PPCX_TAILCALL(c, f_000100F0)`. Entering the split function from its top would leave `0x42`. |
| `fault` | fault | Exit 9. Read of 4 bytes at `0x01000000` (a hole between image and stack) with the register dump and empty stdout. |
| `no-image` | boot | Exit 9. Without `PPCX_IMAGE` the first data read at `0x00020100` faults instead of returning zeroes. |

After a successful boot the driver prints the guest-memory probes
(`checkpoint <name>=<value>`): the three applied `.rodata` pointers, the two
TLS bytes still holding their authored `DDDDDDDD`/`EEEEEEEE`, the `.data`
words and the two copied words in `.bss` (`memcpy` and the trampoline
`OSBlockMove`). The `tolerant` and `pointer` scenarios assert the untouched
initial values, so a stray write cannot pass unnoticed.

Expected output:

```
boot: 7 scenarios (5 entries compiled), 33 transcript lines, 48 memory probe lines, compiled with <compiler>
boot: OK, the synthetic RPX boots headless with stable checkpoints
```

## What it gates

The fixture found two real defects, both fixed and covered here:

* address-taken imports were absent from the generated `ppcx_import_name`
  table (only REL24 call sites were recorded), so a call through the
  dispatcher trampoline reported `unknown-import` and silently no-opped;
  `translateFunction` now reports `importAddrs` and `translateModule` unions
  them into the name table and the report;
* the initial SP sat at the top of the mapped stack, so the loader's ABI
  frame was outside the region and the first standard prologue faulted on
  its LR save; `ppcx_run` now starts 16 bytes below the top, inside the
  stack.

Both were confirmed by mutation before being accepted: reverting the frame
produced 10 failing expectations and changing one authored data word
produced 4, each with the exact differing transcript/probe lines. The tail
scenario gates the cross-range start fixpoint the same way: run against the
analyzer from before the fix, the harness reports 14 failing expectations,
including the real runtime failure `branch or call to an address with no
registered function (0x000100F0)` and exit 4.

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
