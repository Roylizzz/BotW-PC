# Boot path and relocation call-site map

- **Date:** 2026-10-18 (rev. 7: input call-site map and strict wrapper
  runs; rev. 6 was the prior-art cross-check with the public Switch 1.5.0
  symbol database)
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

   Follow-up (2026-10-19): the coreinit memory/cache primitives among these
   callers now have typed HLE models (`OSBlockMove`, `OSBlockSet`, `memcpy`,
   `memset`, `DCZeroRange`, the data-cache maintenance calls and
   `OSMemoryBarrier`; see the
   [runtime README](../../src/runtime/README.md)); `__tls_get_addr`,
   `OSGetSystemTime` and the remaining services are still open.

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
   in `.rodata` and `.data` are `R_PPC_ADDR32` (type 1) against `$TEXT`;
   the addend plus the `$TEXT` base equals the value stored in the file
   (e.g. addend `0xC48A40` → stored word `0x02C48A40`), so vtable-style
   tables can be read directly from the bytes. The analyzer's pointer scan
   reads both relocation sections (`.rela.data` added 2026-10-19).

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

8. **Two graphics-layer vtables, one interface — but no static
   reference.** `.rela.rodata` pointers place `flush`/`present` in two
   tables: A (`flush` `0x1025FE50`, `present` `0x1025FE68`, methods in
   the `0x0309` module) and B (`flush` `0x10295F6C`, `present`
   `0x10295F84`, methods in `0x031F`). Entries are 8-byte `{code, 0}`
   descriptor-like pairs; unused slots share the default `0x0420CF58`;
   both tables hold the shared method `0x0309D158` right after
   `present`. However, no relocation in any `.rela.*` section and no
   literal data pointer targets either table (or their likely vptr
   bases, `0x1025FE34`/`0x10295F38`), so the objects that use them must
   receive the pointer at runtime (loader-side patch of an object
   template?) — how `GX2SwapScanBuffers` is reached at run time is
   therefore still open. Both implementations share the data layout
   (begin/end callback at `+0x370`, mode word at `+0x28`, flag at
   `+0x375`). Behaviour of the two entries:
   - `present-A` (`FUN_0309D068`): optional callback, `GX2Flush`,
     `GX2SwapScanBuffers` only when `mode==2` and the flag is set,
     `GX2DrawDone`;
   - `present-B` (`FUN_031FA9E0`): same shape plus
     `GX2SetGPUFence(&DAT_1046D420, 0xFFFFFFFF, 6, tick + DAT_1046D440)`,
     `DCInvalidateRange(ptr, 0x20)`, extra virtuals `+0x15C`/`+0x164`, and
     a post-swap display enable (`GX2SetTVEnable(1)`,
     `GX2SetDRCEnable(1)`, `ProcUIDrawDoneRelease()`) when a state field
     equals 2.

    Runtime note (2026-10-20): all five imported proc_ui functions are now
    modeled in the HLE layer. The measured v208 sites are `ProcUIInit` at
    `0x031FA4D4` (the entry that materializes `&UNK_031FA4C8`),
    `ProcUIProcessMessages` at `0x031FAB88` (called with `block = 1`),
    `ProcUIDrawDoneRelease` at `0x031FAB78`, `ProcUIShutdown` at
    `0x031FAB9C`, and `ProcUIRegisterCallback` at `0x2E25A58`, `0x2E25A70`,
    `0x2E25A88`, `0x3424F38`, `0x34ED708` and `0x34ED720` (phases 5, 1, 0,
    0, 1 and one caller-supplied value). The headless model reports
    `IN_FOREGROUND` while initialized, records the registrations without
    invoking them, and reports `EXITING` after shutdown; it does not model
    the HOME-menu transitions or the save callback, so this is lifecycle
    bookkeeping, not full ProcUI behavior.

9. **Interface tables are `$DATA`-relocated.** Class/interface tables in
   `.rodata` are `{code, 0}` arrays whose entries carry `R_PPC_ADDR32`
   relocations against `$TEXT`, and the *code* that points at them uses
   ordinary `$DATA` (`0x10000000`-based) relocations. Example:
   `FUN_034F23B4` (368 B, called from `FUN_034F13CC`) stores
   `&DAT_102CFE24` at object+4; that table starts with three zero words
   and then code pointers `0x034F2524`, `0x034F22CC`, `0x030B0FBC`. The
   same function registers a descriptor pair `{name, &DAT_10263910}`
   (the class-descriptor constant also used for `"GraphicsSystem"`).
   Method lesson: matching nearby `lis`/`addi` pairs by register number
   alone gives false positives under register reuse — `$DATA` relocation
   scans are the reliable way to find who references a table.

10. **GraphicsSystem object map and its start virtual.** `FUN_031FA100`
    (216 B) is the GraphicsSystem constructor:
    - vptr at offset 0 → `0x10295E78`, inside the `0x10295Exx/0x10295Fxx`
      cluster (family B — the one that holds the live `flush`/`present`);
    - second vptr at `+0x380` → `0x10295FE0`; sub-object at `+0x388`
      (`FUN_031faf58`); a `{2,2,0,0}` sub-object at `+0x3C8`; a sub-object
      at `+0x3D8` with vptr `0x10295DE8`; `+0x3E0 = 0` (object size 1000
      bytes).
    The vtable uses the same layout as the other tables (three header
    words `{0,0,0}`, then 8-byte entries), so `main`'s `+0x2C` call is
    method index 4 → `FUN_0309ED98` (284 B), which calls `+0x5C`
    (`FUN_031FA4CC`, returns a static `&UNK_031FA4C8`) and `+0x64`
    (`FUN_0309F7E4`, a no-op in this class), creates
    `"sead::MethodTreeMgr"` through the named-heap helper
    `thunk_FUN_030a5e24` (the helper that also creates the 48 MB
    `"GraphicsSystem"` heap), allocates a 0x564-byte object in that heap
    through `+0x74` (`FUN_031FA48C`, 60 B; stored at `gfx+0x20`), builds
    a method tree from the worker descriptor (`FUN_030a2b20` +
    `FUN_030a18b8`; stored at `gfx+0x1C`), and finishes with `+0x6C`
    (`FUN_0309C81C`, 88 B). Frame scheduling therefore lives in the
    **sead MethodTree**, which drives the `RootTask` virtuals; how the
    tree reaches `present-B` is the next link to reconstruct.

11. **Cross-check against the public symbol database (Switch 1.5.0).**
    The decompilation project `zeldaret/botw` publishes a names-only
    function database for the *Switch* build of the same game version
    (`data/uking_functions.csv`: 113,490 entries, 72,243 named; our Wii U
    RPX itself is stripped — 483 symbols, sections and imports only,
    verified with `tools/rpxinfo`). It names the framework structures this
    note describes on the Wii U side:
    - `uking::frm::RootTask` (`prepare` 432 B, `enter`, `calc` 3,908 B,
      `exit`, `dtor`) and `sead::TTaskFactory<RootTask>` — the factory
      template behind our worker callback `FUN_02c4c0dc`;
    - `sead::GameFrameworkNx` (`initialize_`, `ctor`,
      `initializeGraphicsSystem(sead::Heap*, sead::Vector2f const&)`,
      `presentAsync_(sead::Thread*, s64)`, `swapBuffer_`, `initRun_`,
      `runImpl_`) and `sead::SingleScreenMethodTreeMgr::{calc, draw}` —
      the framework that owns the method tree and the present path;
    - `uking::frm::System::{preCalc, calcAndRunStateMachine, postCalc}`.
    Interpretation: on Switch the present path is a *framework* method
    (`presentAsync_` even takes a `sead::Thread*`), reached through the
    framework's object graph and virtual dispatch — consistent with our
    finding that the Wii U present/flush wrappers (tables A/B) have no
    *direct* static callers. Phase 2 should settle this dynamically
    (address hooks in the HLE runtime / mid-asm hooks), not with
    static-only analysis. Names are facts from a public names-only
    database for the Switch build and are used as vocabulary here, never
    as Wii U addresses.

12. **Input services: KPAD/VPAD initialization and polling sites (2026-10-20).**
    Grouping the 18 non-audio input imports by the containing analysis
    function isolates the v208 input-manager methods (function boundaries
    from `analysis.functionStarts`; call sites from `.rela.text`):
    - `0x030DA08C` (220 B) calls `KPADGetMplsWorkSize` at `0x030DA134`,
      `KPADInitEx` at `0x030DA130` (ring buffer `r31+0x14`, count 0x40) and
      `KPADSetMplsWorkarea` at `0x030DA144`; it has no other import calls.
    - `0x030DA168` (336 B) calls `KPADReadEx` at `0x030DA1C0`; the caller
      passes 16 status entries and stores the sample count/error at
      `+0xF00`/`+0xF04`, confirming `sizeof(KPADStatus) = 0xF0`.
    - `0x030D9F24` (244 B) calls `VPADRead` at `0x030D9F48` with 16 entries
      and count/error at `+0xAC4`/`+0xAC8`, confirming
      `sizeof(VPADStatus) = 0xAC`. It is a method, not a standalone entry:
      `r3` is copied into `r31` and used as the status-context base, so
      starting it with the runtime's `r3 = 0` writes at `0x14` and faults.
    - `0x030D89F8` (1,296 B) calls `VPADGetTPCalibratedPoint` three times
      (`0x030D8C5C`, `0x030D8D10`, `0x030D8D68`).
    - `0x02C57CBC` (360 B) calls the five VPAD gyro setters;
      `0x031A94A4` (180 B) calls `VPADSetSamplingCallback`; `0x030D900C`
      (712 B) calls `VPADControlMotor` twice and `VPADStopMotor` once;
      `0x030C7558`/`0x030C7680` call `WPADProbe`; `0x02C54478` (4,016 B)
      calls `WPADStartSyncDevice`; `0x031A95A4` (548 B) calls
      `WPADEnableURCC`; `0x030D730C` calls
      `VPADBASEGetHeadphoneStatus`.
    - The 18 modeled imports account for 22 REL24 sites; the eight
      remaining padscore sites are the Wii Remote audio/motor path
      (`WENCGetEncodeData` 1, `WPADCanSendStreamData` 1,
      `WPADControlMotor` 2, `WPADControlSpeaker` 3,
      `WPADSendStreamData` 1) and stay unmodeled. Signatures and status
      values were checked against wut `padscore/kpad.h`, `padscore/wpad.h`,
      `vpad/input.h` and `vpadbase/base.h`.
    - Measured strict runs with the 31-segment image: the no-argument
      wrapper `0x030C7558` (13 instructions) calls `WPADProbe(0, &type)`,
      reports `r3 = -1` and returns 0; the no-argument wrapper `0x030D730C`
      (12 instructions) calls `VPADBASEGetHeadphoneStatus(0)`, reports `r3 =
      0` and returns 0. Both exit 0. The model presents one neutral virtual
      GamePad on VPAD channel 0 and no KPAD/WPAD controller; this is not
      host input.

## Evidence quality

- **Observed:** relocation types/counts, `bl` instructions at REL24
  offsets, the single `GX2Init` relocation, caller chains via Ghidra
  references, the 18 input import sites with their containing analysis
  functions and the caller-side buffer offsets (`+0xF00`/`+0xF04` for 16
  KPAD status entries, `+0xAC4`/`+0xAC8` for 16 VPAD entries), plus the
  strict wrapper runs at `0x030C7558` and `0x030D730C`.
- **Derived:** the startup role (`GameConfig`, `RootTask`, 854×480)
  comes from decompiled strings and constants; the input ABI sizes and
  error values come from wut headers, and the headless policy from
  [ADR-0003](../architecture/decisions/0003-headless-input-policy.md).
- **Unknown:** loader patch mechanics; whether every REL24 entry is a
  true call (tail calls and trampolines may be mixed in); how a host input
  backend should map to VPAD/KPAD and whether the game requires a Wii
  Remote/Pro Controller path for any screen.

## Open questions

- Decode how the loader patches `REL24` branch operands (the analyzed
  image shows in-module targets, not import slots).
- Explain why the `0x1025FE40`/`0x10295F44` tables have no static
  reference, and find the real runtime path to `GX2SwapScanBuffers`.
- Identify the task/frame callback that drives the present paths (the
  worker started by the GraphicsSystem `+0x2C` virtual).
- Find out what `mode==2` means and which graphics implementation (A or
  B) the game actually uses per output.
- Identify which virtual method of the `0x101C5F30` cluster is the
  per-frame `run`/`update` callback.
- Resolve the three-word vtable header that precedes the method pointers.
- Map the `GX2Init` argument structure to plan the runtime's graphics
  bootstrap.
