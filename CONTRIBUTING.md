# Contributing to BotW-PC

Thanks for your interest! This project studies *Breath of the Wild* legally
and in the open. Read [DISCLAIMER.md](DISCLAIMER.md) and
[docs/legal/clean-room-policy.md](docs/legal/clean-room-policy.md) before you
contribute.

## The three unbreakable rules

1. **Your own copy.** Only analyze a game copy you legally own. Never share
   game files, keys, or assets with anyone — not through issues, not through
   PRs, not through links.
2. **Original code only.** Everything committed must be written by you (or
   be properly licensed third-party code with attribution). Never paste
   disassembly, decompiler output, or dumped assets.
3. **Notes, not dumps.** Research findings are welcome as *descriptions*:
   offsets, structures, behavior, format documentation. Keep quoted excerpts
   to the minimum needed to make a point.

## Types of contributions

- **Research notes** — findings from your own analysis, in
  [docs/research/](docs/research/) (template included there).
- **Tooling** — original parsers, loaders, converters, build scripts.
- **Runtime code** — original code that consumes user-provided data.
- **Documentation** — format documentation, setup guides, translations.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
docs: add BYML format notes
feat(tools): add AAMP parser prototype
fix: correct SARC alignment handling
chore: update gitignore for dump folders
```

## Pull requests

- Explain what you changed and how you validated it using *your own copy*.
- Include in the PR description: "No copyrighted game content is included in
  this PR."
- PRs that include game content, keys, or unlicensed third-party code are
  closed immediately.

## Reporting issues

Piracy questions ("where do I get the game?"), tooling for DRM circumvention,
and legal gray areas are out of scope. Everything else: welcome.
