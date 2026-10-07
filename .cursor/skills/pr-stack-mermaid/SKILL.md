---
name: pr-stack-mermaid
description: >-
  Maps stacked GitHub pull-request inheritance into a GFM Mermaid flowchart using
  the GitHub CLI, then optionally upserts it at the top of a README. Use when the
  user mentions the PR stack Mermaid skill, stacked PR diagrams, or asks to
  generate a PR stack diagram for the current branch and add it to the README.
---

# PR stack Mermaid

Generate a stacked-PR Mermaid diagram for the **current workspace git repo**. Prefer the bundled script — do not reimplement the tree logic. Shared rules live in `scripts/lib/stackMapper.js` (built from `src/stackMapper.ts` in the pull-request-mapper repo).

## Requirements

- `gh` installed and authenticated (`gh auth login`)
- `git` available
- Workspace is a clone of a GitHub repository
- Node.js 18+ (`node` on `PATH`)
- `scripts/lib/stackMapper.js` present (from `npm run compile` in the upstream repo before install)

## When to run

> Using the PR stack Mermaid skill, generate the diagram for the current branch’s stack and put it at the top of the README.

## Steps

1. Confirm `cwd` is the **target project**.
2. Resolve `<skill-root>/scripts/map-pr-stack` (workspace `.cursor/skills/…` or `~/.cursor/skills/…`).
3. `chmod +x` the wrapper if needed.
4. Run from the target repo. Prefer PR description upsert when the user wants the diagram on the current PR:

   ```bash
   # Upsert into current branch PR description (highlight = that PR)
   <skill-root>/scripts/map-pr-stack --pr-body

   # Or upsert into README
   <skill-root>/scripts/map-pr-stack --readme README.md

   # optional: --closed grayedOut|normal|exclude
   # optional: --max-depth N --exclude-drafts --author LOGIN --label NAME
   # optional: --stdout --root N --highlight N
   ```

5. On failure, fix env / ask the user — do not invent a diagram.
6. After `--pr-body` / `--readme`, confirm what was updated (PR number or path) + root + highlighted PR.

## Behavior

| Topic | Detail |
| --- | --- |
| Highlight | Current branch head PR (or `--highlight`) |
| Root | Walk up bases until none (or `--root`) |
| Tree / Mermaid / README markers | `scripts/lib/stackMapper.js` |
| Defaults | Unlimited depth, include drafts, no author/label filter (`exclude` closed mode) |

## Install

```bash
npx skills add martinshaw/pull-request-mapper
```

Or copy `.cursor/skills/pr-stack-mermaid/` into `~/.cursor/skills/` or another repo’s `.cursor/skills/`. Never install under `~/.cursor/skills-cursor/`.

## Anti-patterns

- Do not call the VS Code extension from the agent — use this script.
- Do not hand-write Mermaid that contradicts `gh pr list` data.
- Do not put real newlines inside node label strings.
