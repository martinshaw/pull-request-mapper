#!/usr/bin/env node
/**
 * Generate a stacked-PR Mermaid diagram (same rules as the Pull Request Mapper extension).
 *
 * Usage (run with cwd = target git repo):
 *   node map-pr-stack.mjs [--closed exclude|grayedOut|normal] [--readme PATH] [--stdout]
 *                         [--root <pr-number>] [--highlight <pr-number>]
 *
 * Default: find PR for current branch, walk up to stack root, highlight current branch,
 * print a markdown section to stdout. With --readme, upsert that section at the top of the file.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const MARKER_START = "<!-- pr-stack-mermaid:start -->";
const MARKER_END = "<!-- pr-stack-mermaid:end -->";
const CLOSED_STYLE = "fill:#e8e8e8,stroke:#9a9a9a,color:#6a6a6a";
const HIGHLIGHT_STYLE = "stroke-width:5px,stroke:#1a1";

function usage(code = 1) {
  console.error(`Usage: map-pr-stack.mjs [options]

Options:
  --closed <mode>     exclude | grayedOut | normal (default: exclude)
  --readme <path>     Upsert diagram section at top of this markdown file
  --stdout            Always print the markdown section to stdout
  --root <number>     Force stack root PR number (default: walk up from current branch)
  --highlight <number> Force highlight PR number (default: current branch PR)
  -h, --help          Show help
`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    closed: "exclude",
    readme: null,
    stdout: false,
    root: null,
    highlight: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--stdout") opts.stdout = true;
    else if (a === "--closed") {
      opts.closed = argv[++i];
      if (!["exclude", "grayedOut", "normal"].includes(opts.closed)) {
        die(`Invalid --closed value: ${opts.closed}`);
      }
    } else if (a === "--readme") opts.readme = argv[++i];
    else if (a === "--root") opts.root = Number(argv[++i]);
    else if (a === "--highlight") opts.highlight = Number(argv[++i]);
    else die(`Unknown argument: ${a}`);
  }
  return opts;
}

function die(msg) {
  console.error(`map-pr-stack: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
      ...opts,
    }).trim();
  } catch (err) {
    if (err && err.code === "ENOENT") {
      die(`\`${cmd}\` is not installed or not on PATH.`);
    }
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
    die(detail || `${cmd} ${args.join(" ")} failed`);
  }
}

function isOpen(pr) {
  return String(pr.state).toUpperCase() === "OPEN";
}

function ensureGh() {
  run("gh", ["--version"]);
  try {
    execFileSync("gh", ["auth", "status"], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    die("GitHub CLI is not authenticated. Run `gh auth login`.");
  }
}

function getBranch() {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    die("Detached HEAD or could not determine current branch.");
  }
  return branch;
}

function getRepo() {
  const repo = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  if (!repo) die("Could not resolve GitHub repository for this directory.");
  return repo;
}

function listPrs(repo, closedMode) {
  const state = closedMode === "exclude" ? "open" : "all";
  const raw = run("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    state,
    "--limit",
    "1000",
    "--json",
    "number,title,headRefName,baseRefName,url,state",
  ]);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    die("Failed to parse `gh pr list` JSON.");
  }
}

function findStackRoot(start, allPrs) {
  const byHead = new Map(allPrs.map((pr) => [pr.headRefName, pr]));
  let root = start;
  const seen = new Set([root.number]);
  for (;;) {
    const parent = byHead.get(root.baseRefName);
    if (!parent) break;
    if (seen.has(parent.number)) break;
    seen.add(parent.number);
    root = parent;
  }
  return root;
}

function buildStackTree(root, allPrs) {
  const byBase = new Map();
  for (const pr of allPrs) {
    const list = byBase.get(pr.baseRefName) ?? [];
    list.push(pr);
    byBase.set(pr.baseRefName, list);
  }
  const visited = new Set();

  function walk(pr) {
    visited.add(pr.number);
    const dependents = byBase.get(pr.headRefName) ?? [];
    const children = [];
    for (const child of dependents) {
      if (visited.has(child.number)) continue;
      children.push(walk(child));
    }
    children.sort((a, b) => a.pr.number - b.pr.number);
    return { pr, children };
  }

  return walk(root);
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

function escapeLabel(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function prLabel(pr) {
  const stateSuffix = isOpen(pr) ? "" : ` (${String(pr.state).toLowerCase()})`;
  return (
    escapeLabel(`${pr.title}${stateSuffix}`) +
    "\\n\\n" +
    escapeLabel(pr.headRefName)
  );
}

function renderMermaid(root, highlightNumber, closedMode) {
  const nodes = [];
  const edges = [];
  let counter = 0;

  function visit(node, parentId) {
    const id = nodeId(counter++);
    nodes.push({ id, pr: node.pr });
    if (parentId) edges.push({ from: id, to: parentId });
    for (const child of node.children) visit(child, id);
  }

  visit(root, null);

  const lines = ["flowchart TB"];
  for (const { id, pr } of nodes) {
    lines.push(`  ${id}["${prLabel(pr)}"]`);
  }
  for (const { id, pr } of nodes) {
    lines.push(`  click ${id} "${pr.url.replace(/"/g, "%22")}"`);
  }
  for (const { from, to } of edges) {
    lines.push(`  ${from} --> ${to}`);
  }

  if (closedMode === "grayedOut") {
    for (const { id, pr } of nodes) {
      if (!isOpen(pr)) lines.push(`  style ${id} ${CLOSED_STYLE}`);
    }
  }

  if (highlightNumber !== undefined) {
    const match = nodes.find((n) => n.pr.number === highlightNumber);
    if (match) {
      const closedGray = closedMode === "grayedOut" && !isOpen(match.pr);
      if (closedGray) {
        const grayOnly = `  style ${match.id} ${CLOSED_STYLE}`;
        const idx = lines.indexOf(grayOnly);
        if (idx !== -1) lines.splice(idx, 1);
        lines.push(`  style ${match.id} ${CLOSED_STYLE},${HIGHLIGHT_STYLE}`);
      } else {
        lines.push(`  style ${match.id} ${HIGHLIGHT_STYLE}`);
      }
    }
  }

  return lines.join("\n");
}

function countNodes(node) {
  return 1 + node.children.reduce((s, c) => s + countNodes(c), 0);
}

function renderSection(repo, tree, root, highlight, closedMode) {
  const mermaid = renderMermaid(tree, highlight.number, closedMode);
  const dependentCount = countNodes(tree) - 1;
  const lines = [
    MARKER_START,
    `## PR stack`,
    "",
    `Repository: \`${repo}\` · Root: [#${root.number}](${root.url}) \`${root.headRefName}\` · Highlighted: [#${highlight.number}](${highlight.url}) \`${highlight.headRefName}\` · Dependents: **${dependentCount}**`,
    "",
    "Arrows point toward the merge base (`child --> parent`).",
    "",
    "```mermaid",
    mermaid,
    "```",
    MARKER_END,
    "",
  ];
  return lines.join("\n");
}

function upsertReadme(readmePath, section) {
  const path = resolve(process.cwd(), readmePath);
  let body = existsSync(path) ? readFileSync(path, "utf8") : "";

  const start = body.indexOf(MARKER_START);
  const end = body.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const afterEnd = end + MARKER_END.length;
    const before = body.slice(0, start).replace(/\s+$/, "");
    const after = body.slice(afterEnd).replace(/^\s*\n?/, "\n");
    body = (before ? before + "\n\n" : "") + section + (after.startsWith("\n") ? after : "\n" + after);
  } else {
    body = section + (body ? body.replace(/^\uFEFF?/, "") : "");
  }

  writeFileSync(path, body.endsWith("\n") ? body : body + "\n", "utf8");
  return path;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensureGh();

  const branch = getBranch();
  const repo = getRepo();
  const prs = listPrs(repo, opts.closed);
  if (prs.length === 0) {
    die(
      opts.closed === "exclude"
        ? `No open pull requests in ${repo}.`
        : `No pull requests in ${repo}.`
    );
  }

  let highlight = opts.highlight
    ? prs.find((p) => p.number === opts.highlight)
    : prs.find((p) => p.headRefName === branch);

  if (!highlight && opts.highlight) {
    die(`No PR #${opts.highlight} in the listed set.`);
  }
  if (!highlight) {
    die(
      `No PR found for checked-out branch \`${branch}\` in ${repo}. Pass --highlight <n> or check out a PR branch.`
    );
  }

  let root = opts.root
    ? prs.find((p) => p.number === opts.root)
    : findStackRoot(highlight, prs);

  if (!root) die(`No PR #${opts.root} in the listed set.`);

  const tree = buildStackTree(root, prs);
  const section = renderSection(repo, tree, root, highlight, opts.closed);

  if (opts.readme) {
    const path = upsertReadme(opts.readme, section);
    console.error(`Updated ${path}`);
  }

  if (opts.stdout || !opts.readme) {
    process.stdout.write(section.endsWith("\n") ? section : section + "\n");
  }
}

main();
