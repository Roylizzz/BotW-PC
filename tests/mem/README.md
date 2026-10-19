# tests/mem

Compiled conformance tests for the checked guest-memory model
(`src/runtime/src/ppcx_mem.c` and the accessors in
`src/runtime/include/ppcx_abi.h`). Everything here is synthetic; no game
data is required or produced.

## What it does

`run.js`:

1. generates one C driver that installs a small region map
   (`ppcx_mem_reset` for the stack, then two out-of-order `ppcx_mem_add`
   calls) and exercises the model through the real guest accessors;
2. compiles the driver together with `src/runtime/src/ppcx_mem.c` using a
   real host compiler (shared discovery: `PPCX_CC`, then
   `cc`/`gcc`/`clang`/`tcc`);
3. checks, in separate processes:

   * **raw mode** (no model installed): accesses outside every future region
     keep the flat-address behavior;
   * **basic mode**: sorted region listing, duplicate/overlap/invalid
     `ppcx_mem_add` return codes, first/last byte of every region,
     unaligned and host-order accesses, `dcbz` clearing exactly one 32-byte
     block inside a region;
   * **fault mode**: one process per illegal access (past a region end,
     before a region start, straddling a boundary, wrapping the 32-bit
     address space, arena holes, unmapped `dcbz`, below the stack). Each must
     print the exact diagnostic on stderr and exit with code 9, with empty
     stdout — the access is refused before touching the target address;
   * **hook mode**: the registered fault hook runs between the diagnostic
     and the exit;
   * **determinism**: the same fault twice produces byte-identical output.

Expected output:

```
mem: basic 27 lines, raw 3 lines, 9 fault cases, hook and determinism checks, compiled with <compiler>
mem: OK, checked accesses match the mapped regions and faults stop deterministically
```

```sh
node tests/mem/run.js                      # CLI, exits non-zero on mismatch
node --test "tests/mem/*.test.js"          # node:test wrapper (skips without a compiler)
```

See `src/runtime/README.md` for how the runtime installs the model and what
the exit codes mean, and `tests/loader/README.md` for how a loaded image
registers its segments.
