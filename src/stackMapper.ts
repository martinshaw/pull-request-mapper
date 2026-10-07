/**
 * Pure stacked-PR → Mermaid logic shared by the extension and the agent skill.
 * No vscode, no gh, no network.
 */

export type ClosedPullRequestsMode = "exclude" | "grayedOut" | "normal";

export type PullRequest = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  state: string;
  isDraft?: boolean;
  authorLogin?: string;
  labels?: string[];
};

export type StackFilters = {
  /** 0 = unlimited. Positive N = max dependent levels below the root (root is level 0). */
  maxDepth: number;
  excludeDrafts: boolean;
  /** GitHub login; empty = no filter */
  authorFilter: string;
  /** Label name; empty = no filter */
  labelFilter: string;
};

/** Defaults preserve historical chart output (no filtering). */
export const DEFAULT_STACK_FILTERS: StackFilters = {
  maxDepth: 0,
  excludeDrafts: false,
  authorFilter: "",
  labelFilter: "",
};

export type StackNode = {
  pr: PullRequest;
  children: StackNode[];
};

export type DiagramNode = {
  id: string;
  pr: PullRequest;
};

export const MARKER_START = "<!-- pr-stack-mermaid:start -->";
export const MARKER_END = "<!-- pr-stack-mermaid:end -->";

const CLOSED_STYLE = "fill:#e8e8e8,stroke:#9a9a9a,color:#6a6a6a";
const HIGHLIGHT_STYLE = "stroke-width:5px,stroke:#1a1";

/** Synthetic root for a remote branch that has no pull request. */
export const BRANCH_STATE = "BRANCH";

export function isOpenPullRequest(pr: { state: string }): boolean {
  return pr.state.toUpperCase() === "OPEN";
}

export function isBranchOnlyRoot(pr: { state: string }): boolean {
  return pr.state.toUpperCase() === BRANCH_STATE;
}

/** Build a stack root node for a branch with no associated PR. */
export function makeBranchRoot(
  branchName: string,
  treeUrl: string
): PullRequest {
  return {
    number: 0,
    title: branchName,
    headRefName: branchName,
    baseRefName: "",
    url: treeUrl,
    state: BRANCH_STATE,
  };
}

export function filterPullRequests(
  prs: PullRequest[],
  filters: StackFilters = DEFAULT_STACK_FILTERS
): PullRequest[] {
  const author = filters.authorFilter.trim();
  const label = filters.labelFilter.trim();

  return prs.filter((pr) => {
    if (filters.excludeDrafts && pr.isDraft) {
      return false;
    }
    if (author && (pr.authorLogin ?? "") !== author) {
      return false;
    }
    if (label) {
      const labels = pr.labels ?? [];
      if (!labels.includes(label)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Walk up baseRefName → headRefName until no parent PR exists in the set.
 */
export function findStackRoot(
  start: PullRequest,
  allPrs: PullRequest[]
): PullRequest {
  const byHead = new Map(allPrs.map((pr) => [pr.headRefName, pr]));
  let root = start;
  const seen = new Set([root.number]);
  for (;;) {
    const parent = byHead.get(root.baseRefName);
    if (!parent || seen.has(parent.number)) {
      break;
    }
    seen.add(parent.number);
    root = parent;
  }
  return root;
}

/**
 * Build the dependent-PR tree rooted at `root`.
 * A child is any PR whose base branch equals the parent's head branch.
 */
export function buildStackTree(
  root: PullRequest,
  allPrs: PullRequest[],
  filters: StackFilters = DEFAULT_STACK_FILTERS
): StackNode {
  const byBase = new Map<string, PullRequest[]>();
  for (const pr of allPrs) {
    const list = byBase.get(pr.baseRefName) ?? [];
    list.push(pr);
    byBase.set(pr.baseRefName, list);
  }

  const visited = new Set<number>();
  const maxDepth = filters.maxDepth;

  function walk(pr: PullRequest, depth: number): StackNode {
    visited.add(pr.number);
    if (maxDepth > 0 && depth >= maxDepth) {
      return { pr, children: [] };
    }
    const dependents = byBase.get(pr.headRefName) ?? [];
    const children: StackNode[] = [];
    for (const child of dependents) {
      if (visited.has(child.number)) {
        continue;
      }
      children.push(walk(child, depth + 1));
    }
    children.sort((a, b) => a.pr.number - b.pr.number);
    return { pr, children };
  }

  return walk(root, 0);
}

function nodeId(index: number): string {
  let n = index;
  let id = "";
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

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

/** @internal exported for tests */
export function escapeLabel(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function prLabel(pr: PullRequest): string {
  if (isBranchOnlyRoot(pr)) {
    return (
      escapeLabel(pr.headRefName) + "\\n\\n" + escapeLabel("(branch · no PR)")
    );
  }
  const stateSuffix = isOpenPullRequest(pr)
    ? ""
    : ` (${pr.state.toLowerCase()})`;
  return (
    escapeLabel(`${pr.title}${stateSuffix}`) +
    "\\n\\n" +
    escapeLabel(pr.headRefName)
  );
}

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

  const lines: string[] = ["flowchart TB"];

  for (const { id, pr } of nodes) {
    lines.push(`  ${id}["${prLabel(pr)}"]`);
  }

  for (const { id, pr } of nodes) {
    const href = pr.url.replace(/"/g, "%22");
    lines.push(`  click ${id} "${href}"`);
  }

  for (const { from, to } of edges) {
    lines.push(`  ${from} --> ${to}`);
  }

  if (closedMode === "grayedOut") {
    for (const { id, pr } of nodes) {
      if (!isOpenPullRequest(pr) && !isBranchOnlyRoot(pr)) {
        lines.push(`  style ${id} ${CLOSED_STYLE}`);
      }
    }
  }

  const highlight = options?.highlightNumber;
  if (highlight !== undefined) {
    const match = nodes.find((n) => n.pr.number === highlight);
    if (match) {
      const closedGray =
        closedMode === "grayedOut" &&
        !isOpenPullRequest(match.pr) &&
        !isBranchOnlyRoot(match.pr);
      if (closedGray) {
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

export function countNodes(node: StackNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

export function countClosedNodes(node: StackNode): number {
  const self =
    isOpenPullRequest(node.pr) || isBranchOnlyRoot(node.pr) ? 0 : 1;
  return (
    self +
    node.children.reduce((sum, child) => sum + countClosedNodes(child), 0)
  );
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

  const selectedHeading = isBranchOnlyRoot(selected)
    ? `PR stack: branch \`${selected.headRefName}\``
    : `PR stack: #${selected.number} — ${selected.title}`;
  const selectedLine = isBranchOnlyRoot(selected)
    ? `Selected branch: \`${selected.headRefName}\` (no pull request)`
    : `Selected PR branch: \`${selected.headRefName}\` (merges into \`${selected.baseRefName}\`)`;
  const highlightLine = isBranchOnlyRoot(highlight)
    ? `Highlighted (current): branch \`${highlight.headRefName}\``
    : `Highlighted (current) PR: \`#${highlight.number}\` \`${highlight.headRefName}\``;
  const openLabel = isBranchOnlyRoot(selected)
    ? `[Open selected branch](${selected.url})`
    : `[Open selected PR](${selected.url})`;

  return [
    `# ${selectedHeading}`,
    "",
    `Repository: \`${repo}\``,
    "",
    selectedLine,
    "",
    highlightLine,
    "",
    `${dependentLabel}: **${dependentCount}**`,
    closedNote,
    "Arrows point toward the merge base (child → parent). Merge from the leaves toward the selected root to land all changes on its branch.",
    "",
    "```mermaid",
    mermaid,
    "```",
    "",
    openLabel,
    "",
  ].join("\n");
}

/**
 * Marked Mermaid-only block for README / PR description upsert.
 * No preamble — just the fence (plus HTML comment markers for replace).
 */
export function renderReadmeSection(
  tree: StackNode,
  highlight: PullRequest,
  closedMode: ClosedPullRequestsMode
): string {
  const mermaid = renderMermaid(tree, {
    highlightNumber: highlight.number,
    closedPullRequests: closedMode,
  });
  return [MARKER_START, "```mermaid", mermaid, "```", MARKER_END, ""].join(
    "\n"
  );
}

/**
 * Insert or replace the marked PR-stack block at the top of a markdown body
 * (README, PR description, etc.).
 */
export function upsertMarkedSection(body: string, section: string): string {
  const start = body.indexOf(MARKER_START);
  const end = body.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const afterEnd = end + MARKER_END.length;
    const before = body.slice(0, start).replace(/\s+$/, "");
    const after = body.slice(afterEnd).replace(/^\s*\n?/, "\n");
    return (
      (before ? before + "\n\n" : "") +
      section +
      (after.startsWith("\n") ? after : "\n" + after)
    );
  }
  const rest = body.replace(/^\uFEFF?/, "");
  return section + rest;
}

/** @deprecated Alias of {@link upsertMarkedSection}. */
export function upsertReadmeSection(body: string, section: string): string {
  return upsertMarkedSection(body, section);
}

/** Basename matches README with optional known extension (case-insensitive). */
export function isReadmeFileName(fileName: string): boolean {
  return /^(readme)(\.(md|markdown|mdown|mkdn|mkd|txt))?$/i.test(fileName);
}
