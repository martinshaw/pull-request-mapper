---
name: pr-stack-mermaid
description: >-
  Maps stacked GitHub pull-request inheritance into a GFM Mermaid flowchart using
  the GitHub CLI, then optionally upserts it at the top of a README. Use when the
  user mentions the PR stack Mermaid skill, stacked PR diagrams, or asks to
  generate a PR stack diagram for the current branch and add it to the README.
---

# PR stack Mermaid

Generate a stacked-PR Mermaid diagram for the **current workspace git repo** (same rules as the [Pull Request Mapper](https://github.com/martinshaw/pull-request-mapper) extension). Prefer running the bundled script — do not reimplement the tree logic.

## Requirements

- `gh` installed and authenticated (`gh auth login`)
- `git` available
- Workspace is a clone of a GitHub repository
- Node.js 18+ (`node` on `PATH`)

## When to run

Typical user request (verbatim intent):

> Using the PR stack Mermaid skill, generate the diagram for the current branch’s stack and put it at the top of the README.

Also use this skill for similar asks (stack diagram, Mermaid PR map, highlight current branch, prepend/update README).

## Steps

1. Confirm `cwd` is the **target project** (the repo whose PRs should be mapped), not this skill’s directory.
2. Resolve this skill’s script path. The script lives next to this file:

   `scripts/map-pr-stack`  
   (or `scripts/map-pr-stack.mjs`)

   If you opened the skill from a checkout of `pull-request-mapper`, that is:

   `.cursor/skills/pr-stack-mermaid/scripts/map-pr-stack`

   If the skill was copied to the personal skills folder:

   `~/.cursor/skills/pr-stack-mermaid/scripts/map-pr-stack`

3. Make the wrapper executable if needed: `chmod +x <skill-root>/scripts/map-pr-stack`
4. Run from the **target repo** cwd:

   ```bash
   <skill-root>/scripts/map-pr-stack --readme README.md
   ```

   Common variants:

   ```bash
   # Include closed/merged PRs, grayed out (matches extension grayedOut setting)
   <skill-root>/scripts/map-pr-stack --closed grayedOut --readme README.md

   # Print only (no file write)
   <skill-root>/scripts/map-pr-stack --stdout

   # Force root / highlight PR numbers
   <skill-root>/scripts/map-pr-stack --root 1 --highlight 15 --readme README.md
   ```

5. If the script fails (no PR for current branch, `gh` auth, etc.), fix the environment or ask the user — do not invent a diagram.
6. After a successful `--readme` run, briefly confirm the path updated and summarize root + highlighted PR.

## Script behavior (do not diverge)

| Behavior | Detail |
| --- | --- |
| Current branch | `git rev-parse --abbrev-ref HEAD` |
| Highlight | PR whose `headRefName` equals the current branch (or `--highlight`) |
| Stack root | Walk up `baseRefName` → other PR `headRefName` until none (or `--root`) |
| Tree | Dependents = PRs whose `baseRefName` equals parent `headRefName` |
| Fetch | One `gh pr list` (`open` if `--closed exclude`, else `all`) |
| Mermaid | Dense fence; labels use literal `\n`; entity-escape `#` `"` `<>`; `click` links; gray styles when `--closed grayedOut` |
| README | Upserts block between `<!-- pr-stack-mermaid:start -->` and `<!-- pr-stack-mermaid:end -->`; inserts at **top of file** if markers are missing |

## Closed-PR modes

| `--closed` | Meaning |
| --- | --- |
| `exclude` (default) | Open PRs only |
| `grayedOut` | Include closed/merged with muted Mermaid styling |
| `normal` | Include closed/merged with normal styling |

## Install into another environment

Copy this whole directory so agents in other projects can load it:

```bash
# Personal (all projects)
mkdir -p ~/.cursor/skills
cp -R .cursor/skills/pr-stack-mermaid ~/.cursor/skills/

# Or into a specific app repo
cp -R .cursor/skills/pr-stack-mermaid /path/to/other-repo/.cursor/skills/
```

Do **not** install under `~/.cursor/skills-cursor/` (Cursor built-ins only).

## Anti-patterns

- Do not call the VS Code extension command from the agent — use this script.
- Do not hand-write Mermaid that contradicts `gh pr list` data.
- Do not put real newlines inside node label strings; the script emits `\n` escapes for GFM.
