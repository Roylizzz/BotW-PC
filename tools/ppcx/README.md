# ppcx

Original PowerPC → C static recompiler prototype for Wii U RPX modules,
written for the BotW-PC project (MIT, no Nintendo code in this repository).

It is the Fase 2 tool of the port plan (see
`docs/architecture/decisions/0002-port-approach.md`): translate the
user's own `U-King.rpx` into plain C that the project's small runtime
(`src/runtime`) can compile and execute on a PC.

Nothing that ppcx produces is ever committed: the generated C is a derived
work of a copyrighted game and goes to `build/` (git-ignored). The
repository only contains the tool and its synthetic tests.

## What it does

| Subcommand  | Purpose |
| ----------- | ------- |
| `analyze`   | Discover function boundaries in `.text` (bl targets, prologue heuristics and `.rodata` code pointers) and measure instruction coverage of the decoder. |
| `imports`   | Inventory the module's imports (`.fimport_*` / `.dimport_*` slots) with their REL24 call sites and ADDR16 address sites. |
| `translate` | Translate a function (optionally following its callees) into C: `build/ppcx/gen.c`. |
| `disasm`    | Disassemble a small address range (debugging aid). |

## Usage

```sh
node tools/ppcx/ppcx.js analyze   --rpx /path/to/U-King-v208.rpx
node tools/ppcx/ppcx.js imports   --rpx /path/to/U-King-v208.rpx --list
node tools/ppcx/ppcx.js disasm    --rpx /path/to/U-King-v208.rpx --addr 0x031FA4CC --count 8
node tools/ppcx/ppcx.js translate --rpx /path/to/U-King-v208.rpx --fn 0x031FA4CC \
                                   --follow 1 --out build/ppcx
```

`translate` caches the whole-function census next to its output
(`build/ppcx/analysis.json`) so repeated translations are fast, and writes a
report with every warning, unsupported instruction and dispatch target it
left behind (`build/ppcx/translate-report.json`).

## Prototype status (October 2026)

The pipeline runs against the real module (9,248,515 words of `.text`):

* `analyze` finishes in ~2.3 s: 99.9993% of words decode to supported
  instructions (9,248,451 of 9,248,515), none are known-but-unsupported and
  64 words are unknown/data — re-measured on 2026-10-19 after implementing
  `psq_l`/`psq_st` and the indexed forms (post-audit snapshot: 97.71% /
  2.29% / 0.00%).
* Boundary discovery finds 96,874 branch-derived starts (the local Ghidra
  census of the same module has 97,363) plus 104,026 pointer-only starts
  taken from `.rodata` code pointers (vtable/callback/constant-getter table
  entries that no branch scan can reach).
* The imports map covers 445 slots: 16,682 REL24 sites (16,522 `bl` calls
  and 160 `b` tail calls) and 40 ADDR16 address-taken sites.
* End-to-end demo: `FUN_031FA4CC` (`r3 = &UNK_031FA4C8; b ProcUIInit` in the
  v208 dump) translates to C, compiles with the local TCC and runs:

  ```
  ppcx: entry 0x031FA4CC, 1 translated function(s)
  ppcx: HLE call #1: proc_ui.ProcUIInit (import 359)
  ppcx: entry returned, r3 = 0x031FA4C8
  ```

Full notes, metrics and the remaining gaps towards a first GX2 frame are in
`docs/research/2026-10-recompiler-prototype.md`.

## Translation model (first iteration)

* One guest function becomes one `static void f_XXXXXXXX(Cpu *c)`.
* Guest state lives in `Cpu` (`src/runtime/include/ppcx_abi.h`); guest
  memory is a flat 32-bit arena the runtime allocates.
* `bl` to an import relocation becomes `PPCX_HLE(c, idx)`; a `b` to an
  import relocation is a tail call (`PPCX_HLE(c, idx); return;` — the import
  returns straight to the wrapper's caller). Taking the address of an import
  (ADDR16 HA/LO) becomes `PPCX_IMPORT_ADDR(idx)`.
* Calls to translated functions are C calls; `blr` is `return;`. Returns
  therefore follow the C stack, which matches regular call/return code.
* Branches whose target is not in the translated set, indirect calls and
  fall-through out of a range are handed to the runtime dispatcher
  (`ppcx_dispatch`), which either runs the registered function or stops
  with a diagnostic naming the exact address.
* Quantized paired-single loads/stores (`psq_l`/`psq_lu`/`psq_st`/`psq_stu`
  and the indexed forms) lower to `ppcx_psq_l`/`ppcx_psq_st` with the GQR
  index and the `W` bit as immediates; the runtime helpers implement the
  reference dequantize/quantize, clamping and float-store FTZ semantics.
* Unsupported instructions emit `PPCX_UNIMPL(c, addr)` — execution stops
  with the address instead of silently skipping a side effect.

Documented fidelity gaps of this iteration (see the header of
`src/runtime/include/ppcx_abi.h` for details): FPSCR flags are not modelled,
the Gekko "1.5" quirk around single-precision arithmetic is approximated,
quantized stores of NaN payloads take the type minimum (the reference
implementation leaves that case undefined), and reservations
(`lwarx`/`stwcx.`) are single-threaded. The quantized paired-single loads and
stores themselves are implemented against the modelled GQRs with the
reference semantics; because the game never writes HID2 but executes `psq_*`
from the start, the model boots with `HID2.LSQE` set (documented assumption).

## Tests

```sh
cd tools/ppcx && npm test                                       # 82 decoder/translator cases
# from the repository root: 3 compiled harness cases (needs a C compiler)
node --test "tests/isa/*.test.js" "tools/ppcx/tests/*.test.js"
```

The harness (`tests/isa`) translates 221 synthetic guest programs, compiles
the generated C with a real compiler (`PPCX_CC`, or `cc`/`gcc`/`clang`/`tcc`
from PATH) and compares the complete machine state — including raw-bit FPR
lanes and the GQR/HID2 registers — against an independent oracle. The 2026-10
audit proved every fixed defect by re-introducing it and watching the harness
fail (10/10 detected).

All tests use only synthetic instruction sequences and synthetic import
tables; no game data is required.
