# Reverse engineering with REA

We use [REA](https://github.com/morluto/rea) — an MIT-licensed, local-only
reverse-engineering toolkit that drives Ghidra, IDA, or Hopper from your
agent or terminal — to analyze **our own copies** of the game.

## Setup

Requirements (Windows / Linux / macOS):

- Node.js 22.x (>= 22.19), 24.x (>= 24.11), or 26+ with npm.
- Optional deep-analysis provider (bring your own):
  - **Ghidra** — use a PowerPC-capable release for Wii U binaries
    (see REA's `docs/ghidra-ppc.md`).
  - or IDA / Hopper.
- The game copy **you legally own**, on your local disk only.

```bash
# One-off CLI use — see "rea --help" and REA's docs/cli.md for commands
npx -y rea-agents@latest --help

# Or register REA's MCP server with your agent
npx rea-agents@latest setup
```

Windows notes: quote paths, e.g. `"D:/dumps/botw/content/..."`. For a
long-lived agent setup, install the package once and point the agent at the
absolute `node.exe` + `rea-agents/scripts/rea.mjs` entry instead of
re-running `npx` at every start (see [environment.md](environment.md)).

## Workflow

1. Pick a well-scoped question ("where is save data parsed?", "what reads
   this file?").
2. Analyze your own copy with REA + your provider. Keep analysis databases
   and raw output local.
3. Write findings as notes in `docs/research/` using the template there —
   **descriptions only**, no code dumps
   (see `docs/legal/clean-room-policy.md`).
4. Turn notes into original code under `tools/` or `src/`.

## Scope reminders

- Never upload game files, dumps, or analysis databases to this repo or to
  issues.
- Analysis databases (Ghidra projects, IDA databases) stay on your machine.
