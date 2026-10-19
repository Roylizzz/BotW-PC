# runtime (prototype)

Host-side runtime for the C code produced by `tools/ppcx translate`.

It provides:

* the flat guest address space (`ppcx_memory`, one arena covering the
  addresses the RPX is linked for),
* the load-image mapper (`src/runtime/src/ppcx_image.c`): maps
  `build/ppcx/image.bin` — every allocated section of the user's own RPX,
  data relocations applied, `.bss` zero-filled — into the arena after
  validating structure, segment order, guest-arena bounds and the payload
  checksum, so a rejected blob never leaves a partial image behind,
* the function registry and its dispatcher (`ppcx_dispatch`),
* diagnostics with full register context for untranslated instructions and
  unregistered targets,
* the HLE entry point for imported system functions, with exact-name coreinit
  core identity models and explicit diagnostics for everything else. This is
  not yet full Cafe OS or multi-core scheduling.

## Build (local prototype)

The generated translation unit and the load image are derived works of the
user's own game dump: they live in `build/` and are never committed.

```powershell
# 1. translate something (writes build/ppcx/gen.c)
node tools/ppcx/ppcx.js translate --rpx <your U-King-v208.rpx> --fn 0x031FA4CC --follow 2

# 2. build the load image (sections, .bss, data relocations)
node tools/ppcx/ppcx.js image --rpx <your U-King-v208.rpx> --out build/ppcx

# 3. compile with the local TCC
tcc -I src/runtime/include -DPPCX_NO_FMA `
    src/runtime/src/ppcx_runtime.c src/runtime/src/ppcx_image.c src/runtime/src/ppcx_hle.c `
    src/runtime/src/main.c build/ppcx/gen.c -o build/ppcx/ppcx.exe

# 4. run (maps the image when PPCX_IMAGE points at it)
$env:PPCX_IMAGE = "build\ppcx\image.bin"
build/ppcx/ppcx.exe
```

`-DPPCX_NO_FMA` is only needed on toolchains whose C library lacks
`fma`/`fmaf` (the local TCC + msvcrt combination). The fallback rounds the
multiply-add twice; that only shows up on rare inputs and is fine for the
prototype.

## Environment variables

* `PPCX_IMAGE=<path>` – map a `PPCXIMG1` load image into the arena before the
  entry point runs (fatal — exit code 8 with a diagnostic on stderr — if the
  blob is invalid),
* `PPCX_HLE_TRACE=1` – log every emulated system call,
* `PPCX_HLE_STRICT=1` – abort on the first **unimplemented** system call; implemented core identity calls remain available.

## Loader error codes

`ppcx_image_load_file` / `ppcx_image_load_memory` return 0 on success and
write a one-line diagnostic otherwise:

| Code | Meaning |
| ---- | ------- |
| -1 | invalid arguments, arena not allocated, or out of memory |
| -2 | blob shorter than the header, or bad magic |
| -3 | bad segment count |
| -4 | the segment table runs past the end of the blob |
| -5 | empty segment, unknown segment flags, or a segment outside the guest arena |
| -6 | segments out of order or overlapping |
| -7 | a segment payload runs past the end of the blob |
| -8 | payload checksum (Fletcher-32) mismatch |
| -9 | file I/O error |

Every check runs before the first byte is written. The compiled harness in
`tests/loader` covers the format, the checks and the Fletcher-32 boundaries
against the tool that writes blobs; `tools/ppcx/README.md` documents how the
image is built.

## Implemented HLE subset (synthetic tests)

Four original, exact-name `coreinit` functions are implemented in `ppcx_hle.c`: `OSGetCoreCount` (3), `OSGetCoreId` (1), `OSGetMainCoreId` (1), `OSIsMainCore` (true). The runtime's only guest CPU is assigned to retail Wii U main core 1 **by explicit prototype convention**. This is not actual threading, affinity or scheduling. Return values use r3 (PowerPC ABI). The implementation intentionally changes no other guest registers or memory. It matches the documented interfaces in [devkitPro/wut coreinit/core.h](https://github.com/devkitPro/wut/blob/master/include/coreinit/core.h).

All other imports remain unimplemented, including `proc_ui.ProcUIInit`. In diagnostic mode they are counted but still return as no-ops (not a valid game execution path). Set `PPCX_HLE_STRICT=1` to stop on such calls. Exact module-qualified lookup means similarly named symbols in other modules cannot accidentally be considered implemented.

Run the synthetic native tests without game content:

```sh
cc -std=c11 -Wall -Wextra -Werror -I src/runtime/include src/runtime/src/ppcx_hle.c tests/hle/test_hle.c -o hle_check
./hle_check
```

The workflow runs these checks on every pull request. Do not count modeled core identity calls as evidence of full Cafe OS compatibility.
