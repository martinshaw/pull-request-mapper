import { isOpenPullRequest, type PullRequest } from "./gh";
import type { ClosedPullRequestsMode } from "./settings";

export type StackNode = {
  pr: PullRequest;
  children: StackNode[];
};

/**
 * Build the dependent-PR tree rooted at `root`.
 * A child is any PR whose base branch equals the parent's head branch.
 */
export function buildStackTree(
  root: PullRequest,
  allPrs: PullRequest[]
): StackNode {
  const byBase = new Map<string, PullRequest[]>();
  for (const pr of allPrs) {
    const list = byBase.get(pr.baseRefName) ?? [];
    list.push(pr);
    byBase.set(pr.baseRefName, list);
  }

  const visited = new Set<number>();

  function walk(pr: PullRequest): StackNode {
    visited.add(pr.number);
    const dependents = byBase.get(pr.headRefName) ?? [];
    const children: StackNode[] = [];
    for (const child of dependents) {
      if (visited.has(child.number)) {
        continue;
      }
      children.push(walk(child));
    }
    children.sort((a, b) => a.pr.number - b.pr.number);
    return { pr, children };
  }

  return walk(root);
}

export type DiagramNode = {
  id: string;
  pr: PullRequest;
};

function nodeId(index: number): string {
  // A, B, ... Z, AA, AB, ...
  let n = index;
  let id = "";
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

/**
 * Depth-first pre-order walk matching Mermaid node letter assignment (A, B, …).
 */
export function enumerateDiagramNodes(root: StackNode): DiagramNode[] {
  const nodes: DiagramNode[] = [];
  let counter = 0;

  function visit(node: StackNode): void {
    nodes.push({ id: nodeId(counter++), pr: node.pr });
    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);
  return nodes;
}

/**
 * Escape plain-text flowchart labels for Mermaid + GFM.
 * Keep each node definition on a single source line: use literal `\n` (not
 * real newlines) so GitHub’s Mermaid fence parser does not split labels.
 */
function escapeLabel(text: string): string {
  // Escape `#` before introducing Mermaid entities like `#quot;`.
  return text
    .replace(/\\/g, "\\\\")
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function prLabel(pr: PullRequest): string {
  const stateSuffix = isOpenPullRequest(pr) ? "" : ` (${pr.state.toLowerCase()})`;
  // Single-line Mermaid source: `\n\n` is the Mermaid line-break escape.
  return escapeLabel(`${pr.title}${stateSuffix}`) + "\\n\\n" + escapeLabel(pr.headRefName);
}

/** Grayed-out look for closed/merged nodes when mode is `grayedOut`. */
const CLOSED_STYLE = "fill:#e8e8e8,stroke:#9a9a9a,color:#6a6a6a";
const HIGHLIGHT_STYLE = "stroke-width:5px,stroke:#1a1";

/**
 * Render a Mermaid flowchart matching the stack style:
 * dependents point at their base (merge direction).
 */
export function renderMermaid(
  root: StackNode,
  options?: {
    highlightNumber?: number;
    closedPullRequests?: ClosedPullRequestsMode;
  }
): string {
  const closedMode = options?.closedPullRequests ?? "exclude";
  const nodes: DiagramNode[] = [];
  const edges: { from: string; to: string }[] = [];
  let counter = 0;

  function visit(node: StackNode, parentId: string | null): void {
    const id = nodeId(counter++);
    nodes.push({ id, pr: node.pr });
    if (parentId) {
      edges.push({ from: id, to: parentId });
    }
    for (const child of node.children) {
      visit(child, id);
    }
  }

  visit(root, null);

  // Prefer dense, single-purpose lines (no blank lines inside the fence).
  // GFM Mermaid is happier when node labels stay on one physical line.
  const lines: string[] = ["flowchart TB"];

  for (const { id, pr } of nodes) {
    lines.push(`  ${id}["${prLabel(pr)}"]`);
  }

  for (const { id, pr } of nodes) {
    // Quote URLs; escape embedded quotes defensively.
    const href = pr.url.replace(/"/g, "%22");
    lines.push(`  click ${id} "${href}"`);
  }

  for (const { from, to } of edges) {
    lines.push(`  ${from} --> ${to}`);
  }

  if (closedMode === "grayedOut") {
    for (const { id, pr } of nodes) {
      if (!isOpenPullRequest(pr)) {
        lines.push(`  style ${id} ${CLOSED_STYLE}`);
      }
    }
  }

  const highlight = options?.highlightNumber;
  if (highlight !== undefined) {
    const match = nodes.find((n) => n.pr.number === highlight);
    if (match) {
      const closedGray =
        closedMode === "grayedOut" && !isOpenPullRequest(match.pr);
      if (closedGray) {
        // Replace the gray-only line with combined highlight + gray.
        const grayOnly = `  style ${match.id} ${CLOSED_STYLE}`;
        const idx = lines.indexOf(grayOnly);
        if (idx !== -1) {
          lines.splice(idx, 1);
        }
        lines.push(`  style ${match.id} ${CLOSED_STYLE},${HIGHLIGHT_STYLE}`);
      } else {
        lines.push(`  style ${match.id} ${HIGHLIGHT_STYLE}`);
      }
    }
  }

  return lines.join("\n");
}

export function renderMarkdownDocument(
  root: StackNode,
  repo: string,
  selected: PullRequest,
  highlight: PullRequest,
  closedMode: ClosedPullRequestsMode
): string {
  const mermaid = renderMermaid(root, {
    highlightNumber: highlight.number,
    closedPullRequests: closedMode,
  });
  const dependentCount = countNodes(root) - 1;
  const closedInTree = countClosedNodes(root);
  const dependentLabel =
    closedMode === "exclude"
      ? "Dependent open PRs mapped"
      : "Dependent PRs mapped";

  const closedNote =
    closedMode === "exclude"
      ? ""
      : closedMode === "grayedOut"
        ? `\nClosed/merged PRs in diagram: **${closedInTree}** (grayed out).\n`
        : `\nClosed/merged PRs in diagram: **${closedInTree}** (shown as normal).\n`;

  return [
    `# PR stack: #${selected.number} — ${selected.title}`,
    "",
    `Repository: \`${repo}\``,
    "",
    `Selected PR branch: \`${selected.headRefName}\` (merges into \`${selected.baseRefName}\`)`,
    "",
    `Highlighted (current) PR: \`#${highlight.number}\` \`${highlight.headRefName}\``,
    "",
    `${dependentLabel}: **${dependentCount}**`,
    closedNote,
    "Arrows point toward the merge base (child → parent). Merge from the leaves toward the selected PR to land all changes on its branch.",
    "",
    "```mermaid",
    mermaid,
    "```",
    "",
    `[Open selected PR](${selected.url})`,
    "",
  ].join("\n");
}

function countNodes(node: StackNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function countClosedNodes(node: StackNode): number {
  const self = isOpenPullRequest(node.pr) ? 0 : 1;
  return (
    self +
    node.children.reduce((sum, child) => sum + countClosedNodes(child), 0)
  );
}
