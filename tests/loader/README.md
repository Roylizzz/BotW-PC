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
   words, the report counters and every error code, and probes the
   Fletcher-32 implementation at the 359-byte block boundary;
4. compiles the driver together with `src/runtime/src/ppcx_image.c` using a
   real host compiler (shared discovery: `PPCX_CC`, then
   `cc`/`gcc`/`clang`/`tcc`) and compares the output against expectations
   authored in the fixture.

Expected output:

```
loader: 50 state lines, 10 negative blobs, compiled with <compiler>
loader: OK, the compiled loader matches the synthetic expectations
```

Negative cases must fail with their documented code **before** anything is
written; the harness checks that a sentinel word survives every rejected
blob.

```sh
node tests/loader/run.js                      # CLI, exits non-zero on mismatch
node --test "tests/loader/*.test.js"          # node:test wrapper (skips without a compiler)
```

See `src/runtime/README.md` for the blob format, the error-code table and
the `PPCX_IMAGE` environment variable.
