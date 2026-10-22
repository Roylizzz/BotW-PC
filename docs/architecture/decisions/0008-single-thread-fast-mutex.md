# 8. Single-thread fast-mutex models

- **Date:** 2026-10-22
- **Status:** accepted (implementation policy under ADR-0002)

## Context

The v208 static-constructor path reaches the four coreinit fast-mutex imports
before it reaches the next unregistered indirect dispatch. A bounded
constructor probe with `--expand-window 0x1000` executed 9,417 function entries
and logged nine diagnostic no-ops: seven `OSFastMutex_Init` calls, one
`OSFastMutex_Lock` and one `OSFastMutex_Unlock`. The first cluster at function
entry 3,788 (HLE calls #43-#45) is Init/Lock/Unlock; further Init calls follow
at HLE #52, #205, #208, #210, #213 and #232. The import census has 30
`OSFastMutex_Init`, 76 `OSFastMutex_Lock`, 121 `OSFastMutex_Unlock` and one
`OSFastMutex_TryLock` REL24 site.

The runtime currently executes one guest context and has no scheduler, no
thread queue and no preemption. The real API blocks or wakes threads and
maintains a wait queue; implementing that without a scheduler would be a lie.
Leaving the calls as silent diagnostic no-ops is also unsatisfactory because
strict mode rejects them and because the constructor initializes real guest
objects that later code may inspect.

## Decision

1. **Add exact-name models for the complete fast-mutex family.** The registry
   recognizes `coreinit.OSFastMutex_Init`, `OSFastMutex_Lock`,
   `OSFastMutex_Unlock` and `OSFastMutex_TryLock`. There is no fallback name
   matching.
2. **Init writes the documented wut layout.** An `OSFastMutex` is 0x2C bytes:
   tag at 0x00, name at 0x04, queue at 0x0C, link at 0x14 and unknown bytes
   through 0x2B (devkitPro/wut `coreinit/fastmutex.h`). The model checks the
   whole range when the checked-memory map is active, writes
   `OS_FAST_MUTEX_TAG` (`0x664D7458`) and the guest name pointer, then clears
   the remaining 0x24 bytes. It stores the last pointer/name and a call count
   for diagnostics.
3. **Lock, Unlock and TryLock model only the uncontended single-thread case.**
   `Lock` and `Unlock` are counted no-ops that preserve every register.
   `TryLock` counts the call and returns `TRUE` (1). No queue links, owner,
   recursion count or wait state is maintained, because there is no second
   guest context that could contend.
4. **Reset the counters at the start of every run.** `ppcx_run` calls
   `ppcx_hle_fast_mutex_reset` with the other HLE resets. The reset clears only
   the host-side diagnostic state; it does not rewrite guest mutex objects.
5. **Do not describe this as threading support.** The model is valid only while
   exactly one context executes. Before multiple CPUs, guest threads,
   interrupts or a scheduler are enabled, the no-contention assumption must be
   replaced by real ownership and queue semantics; otherwise double-lock and
   contention bugs are invisible.

## Consequences

- Strict-mode probes no longer stop on the measured fast-mutex calls. After
  the models, the 30-iteration constructor probe advances to the next
  measured dispatch boundary, `0x0420E2C8`, without pretending that a
  blocking lock executed.
- Constructor code that checks the mutex tag or name sees the documented
  values. Code that inspects queue fields sees zeroed storage after `Init`.
- The model can hide a guest double-lock (real `Lock` would block forever) and
  cannot wake a waiter. Those limitations are explicit and tested only at the
  native contract level, not as gameplay behavior.
- The remaining catch-up work is a scheduler/thread implementation with real
  ownership, wait queues, priority and cancellation, followed by revalidation
  of the constructor path.

## Evidence

- wut `include/coreinit/fastmutex.h`: tag `0x664D7458`, offsets 0x00/0x04/0x0C/
  0x14 and size 0x2C; `Init(mutex, name)`, `Lock`, `Unlock`, `TryLock` return
  `BOOL`.
- v208 import census (`build/audit/rela-text.csv`, local and git-ignored):
  30/76/121/1 REL24 sites for Init/Lock/Unlock/TryLock.
- Constructor probe iteration 24 transcript: first unmodeled cluster
  `#43 coreinit.OSFastMutex_Init`, `#44 OSFastMutex_Lock`,
  `#45 OSFastMutex_Unlock`; nine unmodeled calls in total; that run ended at
  `0x030C0EB0` after 7,258 translated functions and 9,417 executed entries.
  After the models, the 30-iteration run translates 7,459 functions and
  643,980 instructions, executes 10,291 entries with 435 HLE calls and zero
  unimplemented HLE, and stops at `0x0420E2C8`.
- Native contract test (`tests/hle/test_hle.c`): tag/name/zeroed fields and
  no write past 0x2C, register preservation for Init/Lock/Unlock, TryLock
  result 1 with no other register changes, counters and reset.
