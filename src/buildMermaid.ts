import type { PullRequest } from "./gh";

export type StackNode = {
  pr: PullRequest;
  children: StackNode[];
};

/**
 * Build the dependent-PR tree rooted at `root`.
 * A child is any open PR whose base branch equals the parent's head branch.
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

function escapeLabel(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "#quot;")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function prLabel(pr: PullRequest): string {
  return escapeLabel(`${pr.title}\n\n${pr.headRefName}`);
}

/**
 * Render a Mermaid flowchart matching the stack style:
 * dependents point at their base (merge direction).
 */
export function renderMermaid(
  root: StackNode,
  options?: { highlightNumber?: number }
): string {
  const nodes: { id: string; pr: PullRequest }[] = [];
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

  const lines: string[] = ["flowchart TB"];

  for (const { id, pr } of nodes) {
    lines.push(`    ${id}["${prLabel(pr)}"]`);
  }

  lines.push("");

  for (const { id, pr } of nodes) {
    lines.push(`    click ${id} "${pr.url}"`);
  }

  lines.push("");

  for (const { from, to } of edges) {
    lines.push(`    ${from}-->${to}`);
  }

  const highlight = options?.highlightNumber;
  if (highlight !== undefined) {
    const match = nodes.find((n) => n.pr.number === highlight);
    if (match) {
      lines.push("");
      lines.push(`    style ${match.id} stroke-width:5px,stroke:#1a1`);
    }
  }

  return lines.join("\n");
}

export function renderMarkdownDocument(
  root: StackNode,
  repo: string,
  selected: PullRequest
): string {
  const mermaid = renderMermaid(root, { highlightNumber: selected.number });
  const dependentCount = countNodes(root) - 1;

  return [
    `# PR stack: #${selected.number} — ${selected.title}`,
    "",
    `Repository: \`${repo}\``,
    "",
    `Selected PR branch: \`${selected.headRefName}\` (merges into \`${selected.baseRefName}\`)`,
    "",
    `Dependent open PRs mapped: **${dependentCount}**`,
    "",
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
