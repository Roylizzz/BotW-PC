# Boot path and relocation call-site map

- **Date:** 2026-10-18
- **Game version:** Wii U update v208 (`code/U-King.rpx`)
- **Tooling:** `tools/rpxinfo relocs`, Ghidra 12.1.4 headless, local scripts
- **Contributor:** @Roylizzz
- **Source:** own copy, analyzed locally

## Question

Where does the executable start, what does the first chain of calls do,
and can the relocation table give us a map of every call into the system
APIs?

## Findings

1. **The relocation table works as a call-site index.** `.rela.text`
   holds 889,935 entries against 448 symbols (census note). Restricting to
   `R_PPC_REL24` leaves 16,690 branch sites, and every sampled offset
   lands on a `bl` instruction. Filtering out `$TEXT`/`$DATA` and joining
   each offset with the containing Ghidra function gives:
   - 16,736 entries with a named target, 16,195 of them inside a known
     function (541 fall into gaps, likely thunk or size-0 regions);
   - top callers: `OSBlockMove` 5,066 functions / 6,836 sites,
     `__tls_get_addr` 2,770 / 3,371, `OSGetCoreId` 539 / 1,380,
     `OSGetSystemTime` 353 / 483, `OSMemoryBarrier` 241 / 332,
     `memcpy` 230 / 410.

2. **Startup chain (v208).** Following entry `0x03C70404`
   (`FUN_03c70404`) and the recovered call sites:
   - `FUN_02c5e5f4` (596 B) loads the `"GameConfig"` resource, creates a
     `"RootTask"` and hands a task entry (`FUN_02c4c0dc`) to the task
     system;
   - `FUN_02c5e368` → `FUN_031fa220` (96 B) → `FUN_0309bbb0` (2,492 B);
   - `FUN_0309bbb0` contains the **only** `GX2Init` call site in the
     binary (`0x0309BC80`) and configures display/render-target state
     around the Wii U GamePad resolution (854×480).

3. **Relocations are applied by the loader, not baked into the file.**
   The `bl` operands in the file point to placeholder addresses just past
   `.text` (`0x04347FA0`; `.text` ends at `0x04347C2C`), not to the import
   slots at `0xC0004540`. Ghidra's raw listing therefore shows unrelated
   in-module targets for import calls; the symbol association above comes
   from the relocation table, not from disassembly. How the Wii U loader
   patches these branches (stub table next to the module vs. rewritten
   instructions) is an open question.

## Evidence quality

- **Observed:** relocation types/counts, `bl` instructions at REL24
  offsets, the single `GX2Init` relocation, caller chains via Ghidra
  references.
- **Derived:** the startup role (`GameConfig`, `RootTask`, 854×480)
  comes from decompiled strings and constants.
- **Unknown:** loader patch mechanics; whether every REL24 entry is a
  true call (tail calls and trampolines may be mixed in).

## Open questions

- Decode how the loader resolves `REL24` against import stubs.
- Identify the first render loop and the task function's frame callback.
- Map the `GX2Init` argument structure to plan the runtime's graphics
  bootstrap.
