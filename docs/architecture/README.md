# Architecture

> Nothing is decided yet. This folder will hold the sketches and decisions
> that emerge from Phase 2 of the [roadmap](../../ROADMAP.md).

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
  (draft; decision deferred to Phase 2)
