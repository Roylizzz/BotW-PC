# Architecture

> The port approach was accepted on 2026-10-18: static PowerPC-to-C recompilation + original Cafe OS HLE runtime, staged incrementally. See [ADR-0002](decisions/0002-port-approach.md).

## Engineering gates

- [Implementation and acceptance plan](implementation-plan.md)
- [Source-level code audit](../audits/2026-10-18-code-audit.md)
- [Comparative modern port research](../research/2026-10-native-port-patterns.md)

## Initial sketch (subject to change)

Whatever direction we choose, the eventual system needs roughly:

1. **Asset layer** — original parsers for the formats present in a user's own
   copy (BYML, AAMP, SARC, BFRES, …), built from public format documentation
   plus our own research notes.
2. **Runtime layer** — original engine code: streaming, scene graph, render
   backend (e.g. Vulkan), audio, input.
3. **Platform layer** — PC (Windows first).

## Decision records

Significant decisions are recorded as short ADRs in `decisions/`:

- [0001 — Use architecture decision records](decisions/0001-use-adr.md)
- [0002 — Port approach: options and evaluation criteria](decisions/0002-port-approach.md)
  (accepted on 2026-10-18)
- [0003 — Headless input policy for the first runtime increment](decisions/0003-headless-input-policy.md)
  (accepted on 2026-10-20)
