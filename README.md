<img src="assets/icon.svg" width="64" height="64" alt="">

# Pull Request Mapper

VS Code / Cursor extension that maps stacked pull-request inheritance for the current workspace repository into a Mermaid flowchart.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and on your `PATH`
- Authenticated session: `gh auth login`
- A workspace folder that is a git clone of a GitHub repository

The extension talks to GitHub **only** through `gh`. It does not call the GitHub REST/GraphQL APIs directly.

## Usage

1. Open the repository folder in the IDE.
2. Run **PR Mapper: Map PR Stack** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
3. Pick a pull request. That PR is the root.
4. A new Markdown tab opens with a Mermaid flowchart of every **open** PR whose base branch is the selected PR’s head branch, then the same check recursively for each dependent.

Arrows point toward the merge base (`child --> parent`). Merge from the leaves toward the selected PR to land the full stack on its branch.

## Example

Against the private fixture repo [`martinshaw/pr-mapper-test`](https://github.com/martinshaw/pr-mapper-test) (4-layer stack, 2 children per parent), selecting **`#2 [L1] Stack PR B`** maps **14** dependent open PRs:

```mermaid
flowchart TB
    A["[L1] Stack PR B

stack/L1-B"]
    B["[L2] Stack PR B1

stack/L2-B1"]
    C["[L3] Stack PR B11

stack/L3-B11"]
    D["[L4] Stack PR B111

stack/L4-B111"]
    E["[L4] Stack PR B112

stack/L4-B112"]
    F["[L3] Stack PR B12

stack/L3-B12"]
    G["[L4] Stack PR B121

stack/L4-B121"]
    H["[L4] Stack PR B122

stack/L4-B122"]
    I["[L2] Stack PR B2

stack/L2-B2"]
    J["[L3] Stack PR B21

stack/L3-B21"]
    K["[L4] Stack PR B211

stack/L4-B211"]
    L["[L4] Stack PR B212

stack/L4-B212"]
    M["[L3] Stack PR B22

stack/L3-B22"]
    N["[L4] Stack PR B221

stack/L4-B221"]
    O["[L4] Stack PR B222

stack/L4-B222"]

    click A "https://github.com/martinshaw/pr-mapper-test/pull/2"
    click B "https://github.com/martinshaw/pr-mapper-test/pull/5"
    click C "https://github.com/martinshaw/pr-mapper-test/pull/11"
    click D "https://github.com/martinshaw/pr-mapper-test/pull/23"
    click E "https://github.com/martinshaw/pr-mapper-test/pull/24"
    click F "https://github.com/martinshaw/pr-mapper-test/pull/12"
    click G "https://github.com/martinshaw/pr-mapper-test/pull/25"
    click H "https://github.com/martinshaw/pr-mapper-test/pull/26"
    click I "https://github.com/martinshaw/pr-mapper-test/pull/6"
    click J "https://github.com/martinshaw/pr-mapper-test/pull/13"
    click K "https://github.com/martinshaw/pr-mapper-test/pull/27"
    click L "https://github.com/martinshaw/pr-mapper-test/pull/28"
    click M "https://github.com/martinshaw/pr-mapper-test/pull/14"
    click N "https://github.com/martinshaw/pr-mapper-test/pull/29"
    click O "https://github.com/martinshaw/pr-mapper-test/pull/30"

    B-->A
    C-->B
    D-->C
    E-->C
    F-->B
    G-->F
    H-->F
    I-->A
    J-->I
    K-->J
    L-->J
    M-->I
    N-->M
    O-->M

    style A stroke-width:5px,stroke:#1a1
```

## How it works (request budget)

For a successful run the extension issues at most:

1. `gh --version` / `gh auth status` — install + auth checks (early return on failure)
2. `gh repo view` — resolve the workspace GitHub repo
3. `gh pr list --repo <repo> --state open --limit 1000 --json …` — **one** list of open PRs

The stack tree is built entirely in memory by matching `baseRefName` → `headRefName`. No per-PR fetches.

## Develop

```bash
npm install
npm run compile
```

Then launch **Run Extension** from the Debug view (F5) to open an Extension Development Host.

## Command

| Command ID | Title |
| --- | --- |
| `pull-request-mapper.mapPrStack` | PR Mapper: Map PR Stack |
