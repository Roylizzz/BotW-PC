# 6. GHS stdio data imports use a separate address table

- **Date:** 2026-10-21
- **Status:** accepted (implementation policy under ADR-0002)

## Context

The v208 module has eight `.dimport_coreinit` data imports. Two of them are
GHS C-library state used by the module's cleanup and libc paths:

- `__gh_FOPEN_MAX`: a 16-bit value read by `lhz` after an `addis` high-half
  relocation.
- `_iob`: the base of the GHS `iobuf` array, read through `addis` + `addi`.

The translator already handled `R_PPC_ADDR16_HA` / `_LO` pairs on `addi` and
`addis`, but every address-taken import was lowered to
`PPCX_IMPORT_ADDR(index)`, which returns a **function trampoline** address
(`0x50000000 + index * 8`). That address is executable dispatcher metadata and
is invalid as a data pointer. In addition, the `__gh_FOPEN_MAX` low-half
relocation sits on an `lhz` displacement, not on `addi`, so patching only
`addi`/`addis` leaves a stale link-time address in the generated code.

The authoritative GHS layout (decaf `coreinit_ghs.cpp`) is
`GHS_FOPEN_MAX = 20`, `ghs_iobuf` size `0x10`, and `_iob[20]` (`0x140` bytes).
`gh_iob_init` flags stdin as readable on channel 0 and stdout/stderr as
writable on channels 1 and 2.

## Decision

1. **Import kind is part of the translation map.** `buildImportMaps` records
   `{ index, type, kind }` for every address-taken import. The translator emits
   `PPCX_IMPORT_ADDR(index)` for `kind === "function"` and
   `PPCX_IMPORT_DATA_ADDR(index)` for `kind === "data"`.
2. **Data imports have their own resolver.** `ppcx_import_data_addr(index)`
   maps the generated qualified name through `ppcx_hle_data_addr()` to modeled
   storage. Unknown data imports stop with a named diagnostic and exit code 7;
   they are never routed to the function trampoline.
3. **All D-form ADDR16_LO sites are patched.** `R_PPC_ADDR16_LO` is applied to
   the displacement of any D-form memory instruction (`lhz`, `lwz`, …), not
   only `addi`. The generated expression uses
   `(u32)(s32)(s16)(... & 0xffffu)`, so the low half is sign-extended exactly
   like the hardware displacement (`0x8000` is `-32768`, not `+32768`).
4. **Storage page.** GHS data lives in a second HLE page at
   `PPCX_GHS_DATA_ADDR = 0x00091000`
   (`0x91000..0x92000`, adjacent to the OSSystemInfo/TLS page):
   - `__gh_FOPEN_MAX` at `0x00091000`, 16-bit big-endian value **20**.
   - `_iob` at `0x00091100`, 20 entries × `0x10` bytes = `0x140` bytes.
   - `_iob[0].info = 0x00000004`, `_iob[1].info = 0x00040002`,
     `_iob[2].info = 0x00080002`; all other bytes are zero.
   `ppcx_hle_ghs_reset()` clears the page and restores those values at run
   start.
5. **Scope.** This models deterministic storage and the three standard-stream
   flag words. It does not implement `FILE` semantics, buffers, file
   descriptors or stdio calls. The other six v208 data imports
   (`__atexit_cleanup`, the `__cpp_exception_*` pointers and the heap function
   pointers) remain unmodeled and fail loudly at run time if a translated unit
   takes their address.

## Consequences

- GHS libc code can compute the `_iob` base and read `__gh_FOPEN_MAX` without
  dereferencing a code trampoline.
- The `__gh_FOPEN_MAX` site proves the generic D-form low-half path; the boot
  fixture uses the same `addis + lhz` shape.
- The model has no filesystem or stdio behavior. A caller that attempts to
  flush a stream still reaches the unmodeled GHS functions and follows the
  normal strict/diagnostic policy.
- The data page is mapped writable and is below the guest image, like the
  existing HLE page. A module that maps either address is rejected by the
  loader instead of aliasing it.

## Evidence

- v208 data-import census: 8 imports in `.dimport_coreinit` at `0xC00052C0`
  (`0x48` bytes). `_iob` has 8 ADDR16 sites, `__gh_FOPEN_MAX` has 4; the latter
  are `addis` + `lhz` pairs at `0x420E852/856` and `0x420E986/98E`.
- decaf `coreinit_ghs.cpp`: `GHS_FOPEN_MAX = 20`, `ghs_iobuf` size `0x10`,
  `_iob[GHS_FOPEN_MAX]`, and the `gh_iob_init` standard-stream flags.
- Native contract test (`tests/hle/test_hle.c`): exact data-name lookup,
  FOPEN value, all 20 iobuf entries, reset of the whole page, and rejection of
  unmodeled/incorrect names.
- Compiled checked-memory test (`tests/mem/run.js`): maps the GHS page and
  reads `0x00091000` / `0x00091100` plus the three info words through the real
  region map.
- Synthetic boot fixture (`tests/boot`): a new entry takes both data imports
  (`addis + lhz` for `__gh_FOPEN_MAX`, `addis + addi` for `_iob`), returns
  `20 + 4 = 0x18`, and the post-run probes read the modeled values.
- Real v208 translation: `ppcx translate --fn 0x0420E824 --follow 0` emits 62
  instructions with no unsupported instruction or warning. It contains
  `PPCX_IMPORT_DATA_ADDR(144)` for the `_iob` `addis` + `addi` pair and
  `ppcx_rd16((u32)(... PPCX_IMPORT_DATA_ADDR(132) ...))` for the
  `__gh_FOPEN_MAX` `addis` + `lhz` pair (indices 144 and 132 in the real
  import table). The function is not executed: it still reaches four external
  dispatch targets and `coreinit.__gh_set_errno`, which are unmodeled, so this
  proves translation shape only.
- Regression check on v208: the rebuilt image is unchanged at 31 segments,
  43,155,811 bytes, 278,749 `ADDR32` sites and 3+3 TLS relocations, and the
  existing TLS demo (`0x03F92140`) still prints
  `HLE modeled #1: coreinit.__tls_get_addr (import 143), r3=0x00090104` with
  strict exit 0. No real v208 function is claimed to exercise the GHS data
  path at run time yet; that is covered synthetically.
