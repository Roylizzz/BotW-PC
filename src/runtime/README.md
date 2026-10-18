# runtime (prototype)

Host-side runtime for the C code produced by `tools/ppcx translate`.

It provides:

* the flat guest address space (`ppcx_memory`, one arena covering the
  addresses the RPX is linked for),
* the function registry and its dispatcher (`ppcx_dispatch`),
* diagnostics with full register context for untranslated instructions and
  unregistered targets,
* the HLE entry point for imported system functions (counted, optionally
  traced; models come with the next milestone).

## Build (local prototype)

The generated translation unit is a derived work of the user's own game
dump: it lives in `build/` and is never committed.

```powershell
# 1. translate something (writes build/ppcx/gen.c)
node tools/ppcx/ppcx.js translate --rpx <your U-King-v208.rpx> --fn 0x031FA4CC --follow 2

# 2. compile with the local TCC
tcc -I src/runtime/include -DPPCX_NO_FMA `
    src/runtime/src/ppcx_runtime.c src/runtime/src/main.c build/ppcx/gen.c `
    -o build/ppcx/ppcx.exe

# 3. run
build/ppcx/ppcx.exe
```

`-DPPCX_NO_FMA` is only needed on toolchains whose C library lacks
`fma`/`fmaf` (the local TCC + msvcrt combination). The fallback rounds the
multiply-add twice; that only shows up on rare inputs and is fine for the
prototype.

## Environment variables

* `PPCX_HLE_TRACE=1` – log every emulated system call,
* `PPCX_HLE_STRICT=1` – abort on the first emulated system call.
