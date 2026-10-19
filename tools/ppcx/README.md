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
| `image`     | Validate and serialize the load image (allocated sections, `.bss` zero-fill, data relocations) into `build/ppcx/image.bin` + `build/ppcx/image.json`. |
| `disasm`    | Disassemble a small address range (debugging aid). |

## Usage

```sh
node tools/ppcx/ppcx.js analyze   --rpx /path/to/U-King-v208.rpx
node tools/ppcx/ppcx.js imports   --rpx /path/to/U-King-v208.rpx --list
node tools/ppcx/ppcx.js disasm    --rpx /path/to/U-King-v208.rpx --addr 0x031FA4CC --count 8
node tools/ppcx/ppcx.js translate --rpx /path/to/U-King-v208.rpx --fn 0x031FA4CC \
                                   --follow 1 --out build/ppcx
node tools/ppcx/ppcx.js image     --rpx /path/to/U-King-v208.rpx --out build/ppcx \
                                   --expect-sha256 <digest>
```

`translate` caches the whole-function census next to its output
(`build/ppcx/analysis.json`) so repeated translations are fast, and writes a
report with every warning, unsupported instruction and dispatch target it
left behind (`build/ppcx/translate-report.json`). The report lists every
import the unit depends on, split into `calls` (REL24 sites) and
`addressTaken` (ADDR16 sites); both kinds are resolved through the generated
`ppcx_import_name`, because an address-taken import is called at run time
through the dispatcher trampoline. The same pipeline is available as a small
Node API (`loadRpx`/`loadRpxFrom`, `computeAnalysis`, `buildRangeMap`,
`scanCallees`, `translateModule`), which `tests/boot` uses to emit one unit
per boot scenario; `translateModule` accepts several roots plus an explicit
`ppcx_entry` and otherwise behaves exactly like the CLI (verified
byte-identical output on the v208 demo).

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
* `image` builds the load image of the same module in ~1.5 s: 31 segments,
  43,155,811 bytes (41,756,342 data + 1,399,469 BSS), 278,749
  `R_PPC_ADDR32` data relocations applied, 889,935 executable-section sites
  left to the recompiler and 6 TLS sites deferred explicitly (see *Load
  image* below).
* End-to-end demo: `FUN_031FA4CC` (`r3 = &UNK_031FA4C8; b ProcUIInit` in the
  v208 dump) translates to C, compiles with the local TCC and runs:

  ```
  ppcx: entry 0x031FA4CC, 1 translated function(s)
  ppcx: entry returned, r3 = 0x031FA4C8
  ppcx: HLE calls: 1 (unimplemented services remain)
  ```

  `PPCX_HLE_TRACE=1` adds the per-call line
  (`ppcx: HLE unimplemented #1: proc_ui.ProcUIInit (import 359)
  [diagnostic no-op]`) and `PPCX_HLE_STRICT=1` stops on the first
  unimplemented call with the register dump and exit code 5. Thirteen
  coreinit identity and memory/cache calls are modeled
  (`src/runtime/src/ppcx_hle.c`); `proc_ui.ProcUIInit` is not one of them.

Full notes, metrics and the remaining gaps towards a first GX2 frame are in
`docs/research/2026-10-recompiler-prototype.md`.

## Load image (sections, `.bss` and data relocations)

```sh
node tools/ppcx/ppcx.js image --rpx /path/to/U-King-v208.rpx --out build/ppcx
```

`image` prepares the guest address space the way the console loader does:
it validates every allocated section (ranges, overlaps, guest-arena bound),
materializes zlib sections, zero-fills NOBITS sections, applies the
`R_PPC_ADDR32` data relocations, and writes `build/ppcx/image.bin` — a
self-describing `PPCXIMG1` blob the runtime maps with bounds, ordering and
checksum checks — plus `build/ppcx/image.json`, the manifest (RPX/blob
digests, per-segment table, applied and deferred relocation counts, notes).
Every segment record carries the BSS bit and the ELF writable bit
(`SHF_WRITE`), so the runtime installs the section permissions together with
the address range.

Policy, explicit and never silent:

* relocations inside executable sections (REL24/ADDR16*) belong to the
  translator: counted and left untouched, because code is translated from
  the file bytes, not relocated in memory;
* `R_PPC_NONE` is counted and skipped;
* TLS relocations (`R_PPC_DTPMOD32`/`R_PPC_DTPREL32`) are deferred and
  listed with their addresses and symbol names (no TLS model yet);
* any other relocation type fails the build, naming every offending site.

Measured on v208 (2026-10-19): 31 segments, 43,155,811 bytes (41,756,342
data + 1,399,469 BSS), 278,749 `R_PPC_ADDR32` applied, 889,935
executable-section sites, 6 TLS sites deferred; 5 segments are writable
(`.rodata`, `.data`, `.module_id`, `.bss`, `.thrbss`; 6,140,245 bytes) and
26 read-only (`.text`, `.syscall`, the import tables and the allocated
metadata; 37,015,566 bytes). The blob (41,756,854 bytes) builds in ~1.5 s
and the runtime maps it in ~0.13 s with `PPCX_IMAGE=build/ppcx/image.bin`
(see `src/runtime/README.md`).

Fidelity notes: executable sections are mapped for data fidelity only —
translated code does not execute from the arena and their relocation sites
keep their link-time values; the blob is a derived local artifact of the
user's own dump and stays under `build/` (git-ignored).

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
The load image maps executable sections for data fidelity only; their
relocation sites stay at link-time values and TLS relocation sites are
deferred (see *Load image*).

## Tests

```sh
cd tools/ppcx && npm test                                       # 97 decoder/translator/image cases
# from the repository root: compiled harnesses (need a C compiler)
node --test "tests/isa/*.test.js" "tests/loader/*.test.js" "tests/mem/*.test.js" "tests/boot/*.test.js" "tools/ppcx/tests/*.test.js"
```

The harness (`tests/isa`) translates 221 synthetic guest programs, compiles
the generated C with a real compiler (`PPCX_CC`, or `cc`/`gcc`/`clang`/`tcc`
from PATH) and compares the complete machine state — including raw-bit FPR
lanes and the GQR/HID2 registers — against an independent oracle. The 2026-10
audit proved every fixed defect by re-introducing it and watching the harness
fail (10/10 detected).

The loader harness (`tests/loader`) builds a synthetic load image with the
real `lib/image.js`, compiles `src/runtime/src/ppcx_image.c` and
`src/runtime/src/ppcx_mem.c` together with a generated driver and compares
the mapped bytes, the report counters, ten corrupted-blob error codes,
Fletcher-32 boundary probes, the registered-region counters and the
per-segment permissions against fixture-authored expectations. A second
process writes to the loaded read-only `.text` and must exit 9 with the
permission diagnostic (`node tests/loader/run.js` → `loader: OK`).

The checked-memory harness (`tests/mem`) compiles the real
`src/runtime/src/ppcx_mem.c` together with `src/runtime/src/ppcx_hle.c` and
a generated driver and verifies the region model through the guest
accessors: raw mode without a model, region registration, permissions and
boundary/unaligned/host accesses, thirteen illegal accesses (nine outside
every region and four writes to a read-only one) each failing in its own
process with exit code 9 and an exact diagnostic, the fault hook and
run-to-run determinism. The HLE part checks the memory/cache models under
the same map (25 positive lines: `OSBlockMove` non-overlapping and
overlapping, `OSBlockSet`, `memcpy`, `memset`, block-granular
`DCZeroRange`, cache/barrier no-ops, read-only source) and four HLE fault
processes (read-only destination, unmapped destination, unmapped source,
read-only `DCZeroRange` block) (`node tests/mem/run.js` → `mem: OK`; the
job runs in CI).

The synthetic boot harness (`tests/boot`) authors a game-free RPX (five
functions, three imports, relocated `.rodata` pointers, two deferred TLS
sites, `.data`/`.bss`), runs it through the real `analyze` →
`translateModule` → `buildImage`/`serializeImage` path, compiles the
generated unit with the real runtime, checked-memory model, image loader and
HLE layer, and boots it headless in six scenarios: modeled calls through a
direct `bl` and through an address-taken import's dispatcher trampoline
(`PPCX_HLE_TRACE`/`PPCX_DISPATCH_TRACE` transcripts), an unmodeled import
tolerated as a counted no-op, `PPCX_HLE_STRICT=1` (exit 5 + register dump), a
pointer-only getter reached from `.rodata`, an unmapped read (exit 9) and the
same boot without `PPCX_IMAGE` (exit 9 at the first data read). Every
stderr/stdout line and every guest-memory probe is compared with
fixture-authored expectations, and the boot run must repeat byte-identically
(`node tests/boot/run.js` → `boot: 6 scenarios … boot: OK`). The fixture
found two defects now gated there: address-taken imports missing from
`ppcx_import_name` and an initial SP that left the loader's ABI frame outside
the stack region.

The native HLE contract test (`tests/hle/test_hle.c`, compiled with
`cc -Wall -Wextra -Werror` in CI) covers the 13 modeled coreinit identity
and memory/cache calls, exact-name matching, register preservation and the
`OSBlockMove` overlap guarantee on a raw arena.

All tests use only synthetic instruction sequences, synthetic import tables
and synthetic RPX fixtures; no game data is required.
