# Boot path and relocation call-site map

- **Date:** 2026-10-18 (rev. 2: import-name fix and vtable cluster)
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

2. **Startup chain (v208), refined after the import-name fix.**
   Following entry `0x03C70404` (`FUN_03c70404`) and the recovered call
   sites:
   - `FUN_02c5e5f4` (596 B) initializes the framework, then builds a task
     descriptor that registers the same worker callback
     (`FUN_02c4c0dc`, 84 B) twice and passes it to virtual slot `+0x2c`
     of the task object returned by `FUN_02c5e368` (652 B);
   - `FUN_02c5e368` → `FUN_031fa220` (96 B) → `FUN_0309bbb0` (2,492 B);
   - `FUN_0309bbb0` contains the **only** `GX2Init` call site in the
     binary (`0x0309BC80`) and configures display/render-target state
     around the Wii U GamePad resolution (854×480);
   - the worker callback allocates a 0x228-byte object and calls
     `FUN_02c48a48` (792 B), the constructor that registers the class
     name string `uking::frm::RootTask` and installs vtable pointers at
     `+0x20` (`0x101C5FA4`) and `+0x70` (`0x101C5EE4`);
   - `FUN_02c4c444` (212 B) is the matching deleting destructor (resets
     `+0x20` to the base vtable, decrements a refcount, frees the object
     when flag bit 0 is set);
   - allocation goes through two small wrappers: `FUN_0308e578(size)`
     and `FUN_0308e5a0(size, heap, align)` →
     `FUN_0308e4c8(heap, size, align, 1)`.

3. **Import calls: the loader attaches named references; one fix makes
   them usable.** In the analyzed database (RPX loader extension) the
   `bl` at `0x0309BC80` displays an in-module target (`0x04004668`), but
   the instruction also carries an `IMPORTED` reference to the real
   import slot (`0xC0004668` → `gx2.rpl::GX2Init`). Running the loader's
   `fix_primary_imports.java` once makes those references primary, after
   which decompiled calls show the real names (`GX2Init(...)`,
   `GX2InitColorBufferRegs(...)`, ...). Without that step, decompiled
   calls resolve against placeholder functions such as `FUN_04004668`.
   How the loader patched the branch operand itself is still not fully
   reconstructed.

4. **Read-only data pointers are relocation-backed and already final.**
   `.rela.rodata` holds 272,819 entries and `.rela.data` 5,936. Pointers
   in `.rodata` are `R_PPC_ADDR32` (type 1) against `$TEXT`; the addend
   plus the `$TEXT` base equals the value stored in the file (e.g.
   addend `0xC48A40` → stored word `0x02C48A40`), so vtable-style tables
   can be read directly from the bytes.

5. **Framework vtable cluster located in `.rodata`.** Around
   `0x101C5F30` sits a run of 4-byte function pointers that starts with a
   destructor pair (complete + deleting), matching the Itanium-style
   layout: `0x02C4C444` (known deleting destructor) appears as the second
   pointer, followed by further virtual methods (`0x02C4DD34`,
   `0x02C48F64`, `0x030A071C`, ...). Many slots share two repeated
   defaults, `0x0420CF58` and `0x0420CED0`, which Ghidra does not list as
   function starts (small shared stubs; still to identify). The
   `RootTask` vptrs stored by the constructor point into this cluster;
   the exact meaning of the three words that precede the first method
   pointer (`{0x140000, 0, 0xFFEC0000}` vs `{0, 0, 0}`) is unresolved.

6. **Present/flip entry points found via `GX2SwapScanBuffers`.** Two
   wrappers call `GX2SwapScanBuffers` + `GX2DrawDone`: `FUN_0309D068`
   (240 B) and `FUN_031FA9E0` (740 B); two flush wrappers call
   `GX2Flush`: `FUN_0309CE20` and `FUN_031FA324` (360 B each). None has a
   direct caller, so they are reached through pointers/virtual dispatch —
   consistent with a graphics layer driven by the framework task system.
   These are the natural anchors for the render loop.

## Evidence quality

- **Observed:** relocation types/counts, `bl` instructions at REL24
  offsets, the single `GX2Init` relocation, caller chains via Ghidra
  references.
- **Derived:** the startup role (`GameConfig`, `RootTask`, 854×480)
  comes from decompiled strings and constants.
- **Unknown:** loader patch mechanics; whether every REL24 entry is a
  true call (tail calls and trampolines may be mixed in).

## Open questions

- Decode how the loader patches `REL24` branch operands (the analyzed
  image shows in-module targets, not import slots).
- Identify which virtual method of the `0x101C5F30` cluster is the
  per-frame `run`/`update` callback, and which present wrapper it calls.
- Resolve the three-word vtable header that precedes the method pointers.
- Map the `GX2Init` argument structure to plan the runtime's graphics
  bootstrap.
