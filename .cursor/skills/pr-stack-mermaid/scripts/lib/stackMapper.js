"use strict";
/**
 * Pure stacked-PR → Mermaid logic shared by the extension and the agent skill.
 * No vscode, no gh, no network.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARKER_END = exports.MARKER_START = exports.DEFAULT_STACK_FILTERS = void 0;
exports.isOpenPullRequest = isOpenPullRequest;
exports.filterPullRequests = filterPullRequests;
exports.findStackRoot = findStackRoot;
exports.buildStackTree = buildStackTree;
exports.enumerateDiagramNodes = enumerateDiagramNodes;
exports.escapeLabel = escapeLabel;
exports.renderMermaid = renderMermaid;
exports.countNodes = countNodes;
exports.countClosedNodes = countClosedNodes;
exports.renderMarkdownDocument = renderMarkdownDocument;
exports.renderReadmeSection = renderReadmeSection;
exports.upsertMarkedSection = upsertMarkedSection;
exports.upsertReadmeSection = upsertReadmeSection;
exports.isReadmeFileName = isReadmeFileName;
/** Defaults preserve historical chart output (no filtering). */
exports.DEFAULT_STACK_FILTERS = {
    maxDepth: 0,
    excludeDrafts: false,
    authorFilter: "",
    labelFilter: "",
};
exports.MARKER_START = "<!-- pr-stack-mermaid:start -->";
exports.MARKER_END = "<!-- pr-stack-mermaid:end -->";
const CLOSED_STYLE = "fill:#e8e8e8,stroke:#9a9a9a,color:#6a6a6a";
const HIGHLIGHT_STYLE = "stroke-width:5px,stroke:#1a1";
function isOpenPullRequest(pr) {
    return pr.state.toUpperCase() === "OPEN";
}
function filterPullRequests(prs, filters = exports.DEFAULT_STACK_FILTERS) {
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
function findStackRoot(start, allPrs) {
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
function buildStackTree(root, allPrs, filters = exports.DEFAULT_STACK_FILTERS) {
    const byBase = new Map();
    for (const pr of allPrs) {
        const list = byBase.get(pr.baseRefName) ?? [];
        list.push(pr);
        byBase.set(pr.baseRefName, list);
    }
    const visited = new Set();
    const maxDepth = filters.maxDepth;
    function walk(pr, depth) {
        visited.add(pr.number);
        if (maxDepth > 0 && depth >= maxDepth) {
            return { pr, children: [] };
        }
        const dependents = byBase.get(pr.headRefName) ?? [];
        const children = [];
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
function nodeId(index) {
    let n = index;
    let id = "";
    do {
        id = String.fromCharCode(65 + (n % 26)) + id;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return id;
}
function enumerateDiagramNodes(root) {
    const nodes = [];
    let counter = 0;
    function visit(node) {
        nodes.push({ id: nodeId(counter++), pr: node.pr });
        for (const child of node.children) {
            visit(child);
        }
    }
    visit(root);
    return nodes;
}
/** @internal exported for tests */
function escapeLabel(text) {
    return text
        .replace(/\\/g, "\\\\")
        .replace(/#/g, "#35;")
        .replace(/"/g, "#quot;")
        .replace(/</g, "#lt;")
        .replace(/>/g, "#gt;")
        .replace(/\r\n|\r|\n/g, "\\n");
}
function prLabel(pr) {
    const stateSuffix = isOpenPullRequest(pr)
        ? ""
        : ` (${pr.state.toLowerCase()})`;
    return (escapeLabel(`${pr.title}${stateSuffix}`) +
        "\\n\\n" +
        escapeLabel(pr.headRefName));
}
function renderMermaid(root, options) {
    const closedMode = options?.closedPullRequests ?? "exclude";
    const nodes = [];
    const edges = [];
    let counter = 0;
    function visit(node, parentId) {
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
    const lines = ["flowchart TB"];
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
            if (!isOpenPullRequest(pr)) {
                lines.push(`  style ${id} ${CLOSED_STYLE}`);
            }
        }
    }
    const highlight = options?.highlightNumber;
    if (highlight !== undefined) {
        const match = nodes.find((n) => n.pr.number === highlight);
        if (match) {
            const closedGray = closedMode === "grayedOut" && !isOpenPullRequest(match.pr);
            if (closedGray) {
                const grayOnly = `  style ${match.id} ${CLOSED_STYLE}`;
                const idx = lines.indexOf(grayOnly);
                if (idx !== -1) {
                    lines.splice(idx, 1);
                }
                lines.push(`  style ${match.id} ${CLOSED_STYLE},${HIGHLIGHT_STYLE}`);
            }
            else {
                lines.push(`  style ${match.id} ${HIGHLIGHT_STYLE}`);
            }
        }
    }
    return lines.join("\n");
}
function countNodes(node) {
    return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}
function countClosedNodes(node) {
    const self = isOpenPullRequest(node.pr) ? 0 : 1;
    return (self +
        node.children.reduce((sum, child) => sum + countClosedNodes(child), 0));
}
function renderMarkdownDocument(root, repo, selected, highlight, closedMode) {
    const mermaid = renderMermaid(root, {
        highlightNumber: highlight.number,
        closedPullRequests: closedMode,
    });
    const dependentCount = countNodes(root) - 1;
    const closedInTree = countClosedNodes(root);
    const dependentLabel = closedMode === "exclude"
        ? "Dependent open PRs mapped"
        : "Dependent PRs mapped";
    const closedNote = closedMode === "exclude"
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
/**
 * Marked Mermaid-only block for README / PR description upsert.
 * No preamble — just the fence (plus HTML comment markers for replace).
 */
function renderReadmeSection(tree, highlight, closedMode) {
    const mermaid = renderMermaid(tree, {
        highlightNumber: highlight.number,
        closedPullRequests: closedMode,
    });
    return [exports.MARKER_START, "```mermaid", mermaid, "```", exports.MARKER_END, ""].join("\n");
}
/**
 * Insert or replace the marked PR-stack block at the top of a markdown body
 * (README, PR description, etc.).
 */
function upsertMarkedSection(body, section) {
    const start = body.indexOf(exports.MARKER_START);
    const end = body.indexOf(exports.MARKER_END);
    if (start !== -1 && end !== -1 && end > start) {
        const afterEnd = end + exports.MARKER_END.length;
        const before = body.slice(0, start).replace(/\s+$/, "");
        const after = body.slice(afterEnd).replace(/^\s*\n?/, "\n");
        return ((before ? before + "\n\n" : "") +
            section +
            (after.startsWith("\n") ? after : "\n" + after));
    }
    const rest = body.replace(/^\uFEFF?/, "");
    return section + rest;
}
/** @deprecated Alias of {@link upsertMarkedSection}. */
function upsertReadmeSection(body, section) {
    return upsertMarkedSection(body, section);
}
/** Basename matches README with optional known extension (case-insensitive). */
function isReadmeFileName(fileName) {
    return /^(readme)(\.(md|markdown|mdown|mkdn|mkd|txt))?$/i.test(fileName);
}
//# sourceMappingURL=stackMapper.js.map