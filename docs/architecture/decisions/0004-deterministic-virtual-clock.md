# 4. Deterministic virtual clock and system-info policy for headless runs

- **Date:** 2026-10-20
- **Status:** accepted (implementation policy under ADR-0002)

## Context

The v208 module imports four clock/system-info functions that translated code
reaches from 374 functions: `OSGetSystemTime` (481 REL24 call sites plus 2
address-taken sites), `OSGetTime` (10), `OSGetSystemInfo` (17) and
`OSTicksToCalendarTime` (2). Ten functions combine `OSGetSystemInfo` with
another clock call. `OSSleepTicks` (7 sites) is also imported but needs a
scheduler and stays out of this increment.

The runtime has no real-time host clock, no timer interrupt and no scheduler.
Reading host wall time would make otherwise identical headless runs differ,
and returning a constant zero would let polling loops that wait for time to
advance spin forever. The first milestone needs a small, exact, testable model
that lets translated code proceed without claiming Cafe OS timing or game
compatibility.

The ABI is the retail Wii U/wut ABI: `OSTime` is a signed 64-bit tick count
returned in `r3:r4` (high word in `r3`), the timer timebase is the bus clock
divided by four, `OSSystemInfo` is 0x20 bytes, and `OSCalendarTime` is ten
32-bit fields (0x28 bytes).

## Decision

Use one deterministic virtual-clock policy:

1. **Timebase.** The virtual timer runs at **62,156,250 Hz**, derived from
   `OSGetSystemInfo()->busClockSpeed = 248,625,000` divided by four. This is a
   model constant, not a measurement of the host or of real hardware timing.
2. **Epoch.** Virtual boot is **2026-01-01 00:00:00 UTC**, 9,497 days after
   the `OSTime` epoch 2000-01-01. The epoch is
   **51,001,739,100,000,000 ticks** (`0x00B531CFBDFB8F00`). It is fixed for
   every run, so a 64-bit value carries a non-zero high word and exercises the
   `r3:r4` return path.
3. **Clock reads.** `OSGetSystemTime` returns ticks since virtual boot;
   `OSGetTime` returns the epoch plus those ticks. Both write the 64-bit
   `OSTime` to `r3:r4`. Every successful read advances the virtual timebase by
   **one 60 Hz frame = 1,035,937 ticks** (`62,156,250 / 60`, integer
   division). Reads therefore have a side effect: a polling loop makes
   deterministic progress, and the first `OSGetSystemTime` returns 1,035,937,
   the second 2,071,874, and so on. `OSGetTime` advances the same timebase.
4. **System info.** `OSGetSystemInfo` returns the reserved HLE data-page
   address `0x00090000` and writes a 0x20-byte `OSSystemInfo`:
   `busClockSpeed = 248,625,000` at 0x00, `coreClockSpeed = 1,243,125,000` at
   0x04, `baseTime =` the virtual epoch at 0x08, and zero reserved bytes
   through 0x1F. The runtime maps the page writable; the model rewrites the
   whole record on each call.
5. **Calendar conversion.** `OSTicksToCalendarTime` consumes a signed
   `OSTime` in `r3:r4` and a guest pointer in `r5`, and writes the ten
   `OSCalendarTime` fields (`tm_sec`, `tm_min`, `tm_hour`, `tm_mday`, `tm_mon`,
   `tm_year`, `tm_wday`, `tm_yday`, `tm_msec`, `tm_usec`) as 32-bit
   big-endian values in **UTC**, with Sunday = 0 and January = 0. The
   conversion is proleptic Gregorian and has no timezone or DST input.
   Negative inputs clamp to 2000-01-01 00:00:00 (wday 6); there is no
   year-9999 clamp because a positive signed `OSTime` cannot reach it.
6. **Out of scope.** `OSSleepTicks`, `OSGetTick`, timer interrupts, guest
   scheduling, thread time and wall-clock synchronization remain unmodeled
   and continue to follow the strict unknown-call policy.

## Consequences

- Headless runs are byte-identical, and tests can assert exact tick values,
  calendar fields and counters without sleeping.
- Code that polls `OSGetSystemTime`/`OSGetTime` progresses at a virtual 60 Hz
  per read rather than at host speed. This is a liveness placeholder, not a
  frame limiter or an emulation of timer interrupts.
- The epoch and bus/core speeds are model constants. They do not claim the
  user's host clock, the game's save timestamp or real Wii U calibration.
- `OSGetSystemInfo` exposes a guest-writable page at `0x00090000`. The page is
  reserved by the runtime and must not overlap a loaded image segment; the
  image loader already rejects overlaps through the checked region map.
- A future scheduler can replace the tick source while keeping the guest ABI
  and the calendar conversion. Until then no code should treat these values
  as real-time or as evidence of game timing compatibility.

## Evidence

- Native contract test: `tests/hle/test_hle.c`, 40 models at the time of this
  decision (the later TLS model brings the registry to 41), including 64-bit
  `r3:r4` halves, system-info guest/host fields, epoch and negative calendar
  cases, untouched trailing bytes and reset.
- Memory-map test: `tests/mem/run.js` maps the HLE page and reads the
  `OSSystemInfo` record through the real checked accessors (31 positive HLE
  lines plus 4 HLE fault cases at the time; the current harness reports 36
  positive lines and 5 fault cases after the TLS increment).
- Real v208 strict runs: `0x030CB524` (11 instructions) calls
  `OSGetSystemInfo` and exits 0; its disassembly computes
  `busClockSpeed / 4 = 62,156,250` in r4 after zeroing r3 (a 64-bit pair; the
  runtime trace prints r3 only). `0x0308E41C` (16 instructions) calls
  `OSGetSystemTime`, stores both return words and exits 0.
