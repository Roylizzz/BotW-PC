# AGENTS.md — working rules for AI agents in this repository

> **Binding rules for every AI agent** (OpenCode or otherwise) working here.
> They exist because agent context is lossy: it gets compacted, summarized and
> truncated, and details *will* be forgotten. Do not skip them.

## 1. Always re-read the context — especially after any compaction

Compaction summaries are never a source of truth. Before acting, and
**always** after a context compaction, reset or new session, re-read in this
order:

1. **Memory first:** Engram — `mem_context`, then `mem_search` with the task
   keywords (`mem_get_observation` for the full text of matches).
2. **Project notes:** `ROADMAP.md`, `docs/research/README.md` and the specific
   research notes and ADRs relevant to the task.
3. **The actual files** being worked on — never edit from memory alone.

The repository is the source of truth; memory is an index into it. If memory
and files disagree, trust the files, and correct the memory.

## 2. Always write everything down — no exceptions

- After **any** decision, bugfix, discovery, measurement or state change,
  record it immediately in Engram (`mem_save`, format **What / Why / Where /
  Learned**). Do not wait to be asked.
- Research findings, format notes and design outcomes also belong in versioned
  `docs/` files next to the code.
- Before ending a session, save a session summary (`mem_session_summary`:
  Goal / Instructions / Discoveries / Accomplished / Next Steps / Relevant
  Files).
- If it is not written down, it did not happen: the next compaction deletes it
  from the agent's mind.

## 3. Keep the documentation up to date — stale docs are a bug

- A change is not finished until the documentation matches reality. After
  any state change, milestone or decision, update every affected document in
  the same session: `README.md`, `ROADMAP.md` (status lines and checkboxes),
  the relevant notes under `docs/research/`, the ADRs under
  `docs/architecture/decisions/` and any `docs/reverse-engineering/` page you
  touched.
- If a document is already outdated, fix it in place instead of writing a
  new file on top. When code and docs disagree, the code is the source of
  truth: correct the document and say why in the commit message.
- Ship documentation updates together with the change they describe, and
  record them in Engram like anything else (rule 2).

## 4. Reverse engineering: use rea first

- This project's reverse-engineering work runs through the **rea MCP server**
  (`tools.rea.*` in Code Mode). When a task involves binaries, artifacts,
  runtimes, browser payloads or file formats, use rea before ad-hoc scripting.
- Work target-first: `open_binary` (or the matching opener), then ask the
  specific question (`binary_overview`, decompilation, call targets, …).
- If `tools.rea.*` is missing from the catalog, rea failed to connect: check
  `opencode mcp list` and the `rea` entry in `~/.config/opencode/opencode.json`
  (launch = absolute `node.exe` + `rea-agents/scripts/rea.mjs`, never `npx`).
- **Windows limitation:** rea's Ghidra provider supports PE (x86/x64/ARM64),
  raw 6502 and related lanes only — it cannot analyze the Wii U **PowerPC**
  RPX/ELF here. For the game binary use the local Ghidra headless scripts
  (`Tools\analysis\ghidra-scripts\`, project `Tools\ghidra-projects\BotWPC.rep`;
  see `docs/reverse-engineering/environment.md`).
- Record rea findings in Engram (rule 2), keeping `evidence_id` values when
  relevant.

## 5. Keep the repository clean (legal first)

- **Zero Nintendo content in this repository**: no assets, no ROM/RomFS
  content, no executables, no keys. Everything game-derived is generated
  locally from the user's own copy and stays git-ignored.
- See `docs/legal/clean-room-policy.md` and `docs/legal/prior-art.md`. The
  legal formula overrides any other consideration.

## 6. Working with the maintainer

- The maintainer communicates in **Spanish**: reply to them in Spanish.
- Keep code, commits and documentation in **English**.

## 7. Native-port research and verified development gates

- Follow [the comparative native-port research](docs/research/2026-10-native-port-patterns.md), [audit](docs/audits/2026-10-18-code-audit.md), and [stabilization roadmap](docs/architecture/implementation-plan.md). Third-party GPL repositories are reading material, not source to copy into MIT code.
- An instruction being decoded as supported is **not** evidence of correct semantics. Add synthetic execution tests and compare CPU registers, CR/XER, memory, flags and branch behavior against an independent reference before marking fixed.
- Never claim tests, compilation, game boot, HLE compatibility or an image on screen without actual measured evidence. Keep all game-derived binaries/output off Git and out of CI artifacts.
- For PowerPC RPX on Windows, direct Ghidra with an RPX loader is authoritative; REA's Windows Ghidra admission does not cover these binaries. See [analysis guidance](docs/reverse-engineering/rea-guidance.md).
