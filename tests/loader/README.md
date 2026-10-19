# tests/loader

Compiled conformance tests for the RPX load image and the runtime loader
(`tools/ppcx/lib/image.js` + `src/runtime/src/ppcx_image.c`). Everything here
is synthetic: the RPX fixture is authored byte by byte in
`tools/ppcx/tests/image-fixture.js`; no game data is required or produced.

## What it does

`run.js`:

1. builds a synthetic RPX fixture with a zlib-compressed `.rodata`, a
   `.data` section, a NOBITS `.bss`, allocated metadata sections, one REL24
   site and ADDR32/DTPMOD32/DTPREL32 relocations;
2. turns it into a `PPCXIMG1` blob with the real `buildImage` +
   `serializeImage` path and derives ten corrupted variants (bad magic,
   short header, bad count, truncated table, empty segment, unknown flags,
   arena escape, overlap, payload escape, checksum);
3. generates one C driver that runs `ppcx_image_load_memory` /
   `ppcx_image_load_file` over the blob and the variants, prints the mapped
   words, the report counters, every error code and the permission of each
   registered segment, and probes the Fletcher-32 implementation at the
   359-byte block boundary; after the negative blobs it installs the checked
   memory model (`ppcx_mem_reset`), so the mapping, the segment registration
   and every probe of the valid blob run through the checked accessors. A
   second process then writes to the loaded read-only `.text`;
4. compiles the driver together with `src/runtime/src/ppcx_image.c` and
   `src/runtime/src/ppcx_mem.c` using a real host compiler (shared
   discovery: `PPCX_CC`, then `cc`/`gcc`/`clang`/`tcc`) and compares the
   output against expectations authored in the fixture.

Expected output:

```
loader: 62 state lines, 10 negative blobs, read-only write fault, compiled with <compiler>
loader: OK, the compiled loader matches the synthetic expectations
```

Negative cases must fail with their documented code **before** anything is
written; the harness checks that a sentinel word survives every rejected
blob. The region counters must show one region (the stack) before the first
load, `1 + segments` after it, and the same value after the second load of
the same blob (re-registration is idempotent). The permission probes compare
each loaded segment with the ELF flags authored in the fixture: `.text` and
the allocated metadata are read-only, while `.rodata` (whose fixture section
carries `SHF_WRITE`), `.data`, `.bss` and the stack are read/write. The
second process writes to the first byte of the loaded `.text` and must exit
with code 9 and the read-only diagnostic naming the `image` region.

```sh
node tests/loader/run.js                      # CLI, exits non-zero on mismatch
node --test "tests/loader/*.test.js"          # node:test wrapper (skips without a compiler)
```

See `src/runtime/README.md` for the blob format, the error-code table and
the `PPCX_IMAGE` environment variable.
