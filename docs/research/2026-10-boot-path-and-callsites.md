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

7. **The "GraphicsSystem" is created in `FUN_02c5e368` (652 B).** The
   function that `main` calls before registering the worker descriptor:
   - allocates a 1000-byte context (`FUN_0308e5a0(1000, heap, 4)`) and
     hands it to `FUN_031fa100` (216 B) together with a fixed struct
     `{1, 0x500, 0x2D0, ...}` (1280×720);
   - creates a 48 MB (`0x3000000`) allocator through `thunk_FUN_030a5e24`
     labelled `"GraphicsSystem"`;
   - calls `FUN_031fa220` (96 B) → `FUN_0309bbb0` (GX2Init) with two
     floats derived from `FUN_03405a9c`/`FUN_03405ad0` results;
   - loads Sead assets: `System/Sead/primitive_renderer_cafe.gsh` and
     `System/font/gx2_font/debug_font(.jis1).gsh/.gtx`;
   - calls its own virtual `+0x2c` (the object `main` later configures
     with the worker descriptor).

8. **Two graphics-layer vtables, one interface.** `.rela.rodata`
   pointers place `flush`/`present` in two tables: A (`flush`
   `0x1025FE50`, `present` `0x1025FE68`, methods in the `0x0309` module)
   and B (`flush` `0x10295F6C`, `present` `0x10295F84`, methods in
   `0x031F`). Entries are 8-byte `{code, 0}` descriptor-like pairs; unused
   slots share the default `0x0420CF58`; both tables hold the shared
   method `0x0309D158` right after `present`. The data layout is shared
   too — begin/end callback at `+0x370`, mode word at `+0x28`, flag at
   `+0x375` — so this looks like one interface with two implementations:
   - `present-A` (`FUN_0309D068`): optional callback, `GX2Flush`,
     `GX2SwapScanBuffers` only when `mode==2` and the flag is set,
     `GX2DrawDone`;
   - `present-B` (`FUN_031FA9E0`): same shape plus
     `GX2SetGPUFence(&DAT_1046D420, 0xFFFFFFFF, 6, tick + DAT_1046D440)`,
     `DCInvalidateRange(ptr, 0x20)`, extra virtuals `+0x15C`/`+0x164`, and
     a post-swap display enable (`GX2SetTVEnable(1)`,
     `GX2SetDRCEnable(1)`, `ProcUIDrawDoneRelease()`) when a state field
     equals 2.

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
- Identify the task/frame callback that drives the present paths (the
  worker started by the GraphicsSystem `+0x2C` virtual).
- Find out what `mode==2` means and which graphics implementation (A or
  B) the game actually uses per output.
- Identify which virtual method of the `0x101C5F30` cluster is the
  per-frame `run`/`update` callback.
- Resolve the three-word vtable header that precedes the method pointers.
- Map the `GX2Init` argument structure to plan the runtime's graphics
  bootstrap.
