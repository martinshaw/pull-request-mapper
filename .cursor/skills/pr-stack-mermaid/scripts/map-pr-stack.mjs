#!/usr/bin/env node
/**
 * CLI wrapper around the shared stackMapper (synced from src/stackMapper.ts).
 *
 * Usage (cwd = target git repo):
 *   node map-pr-stack.mjs [options]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  DEFAULT_STACK_FILTERS,
  buildStackTree,
  filterPullRequests,
  findStackRoot,
  renderReadmeSection,
  upsertMarkedSection,
} = require("./lib/stackMapper.js");

function usage(code = 1) {
  console.error(`Usage: map-pr-stack.mjs [options]

Options:
  --closed <mode>        exclude | grayedOut | normal (default: exclude)
  --max-depth <n>        0 = unlimited (default); else max levels below root
  --exclude-drafts       Omit draft PRs
  --author <login>       Only PRs by this author login
  --label <name>         Only PRs with this label
  --readme <path>        Upsert diagram section into this README file
  --pr-body              Upsert into the current branch PR description (gh pr edit)
  --stdout               Always print the markdown section to stdout
  --root <number>        Force stack root PR number
  --highlight <number>   Force highlight PR number (default with --pr-body: current PR)
  -h, --help             Show help
`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    closed: "exclude",
    readme: null,
    prBody: false,
    stdout: false,
    root: null,
    highlight: null,
    maxDepth: DEFAULT_STACK_FILTERS.maxDepth,
    excludeDrafts: DEFAULT_STACK_FILTERS.excludeDrafts,
    authorFilter: DEFAULT_STACK_FILTERS.authorFilter,
    labelFilter: DEFAULT_STACK_FILTERS.labelFilter,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--stdout") opts.stdout = true;
    else if (a === "--pr-body") opts.prBody = true;
    else if (a === "--exclude-drafts") opts.excludeDrafts = true;
    else if (a === "--closed") {
      opts.closed = argv[++i];
      if (!["exclude", "grayedOut", "normal"].includes(opts.closed)) {
        die(`Invalid --closed value: ${opts.closed}`);
      }
    } else if (a === "--max-depth") opts.maxDepth = Number(argv[++i]);
    else if (a === "--author") opts.authorFilter = argv[++i] ?? "";
    else if (a === "--label") opts.labelFilter = argv[++i] ?? "";
    else if (a === "--readme") opts.readme = argv[++i];
    else if (a === "--root") opts.root = Number(argv[++i]);
    else if (a === "--highlight") opts.highlight = Number(argv[++i]);
    else die(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(opts.maxDepth) || opts.maxDepth < 0) {
    die("--max-depth must be a non-negative number");
  }
  return opts;
}

function die(msg) {
  console.error(`map-pr-stack: ${msg}`);
  process.exit(1);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    }).trim();
  } catch (err) {
    if (err && err.code === "ENOENT") {
      die(`\`${cmd}\` is not installed or not on PATH.`);
    }
    const detail = (err.stderr || err.stdout || err.message || "")
      .toString()
      .trim();
    die(detail || `${cmd} ${args.join(" ")} failed`);
  }
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
    "number,title,headRefName,baseRefName,url,state,isDraft,author,labels",
  ]);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die("Failed to parse `gh pr list` JSON.");
  }
  return parsed.map((rawPr) => ({
    number: rawPr.number,
    title: rawPr.title,
    headRefName: rawPr.headRefName,
    baseRefName: rawPr.baseRefName,
    url: rawPr.url,
    state: rawPr.state,
    isDraft: Boolean(rawPr.isDraft),
    authorLogin: rawPr.author?.login ?? "",
    labels: (rawPr.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name))
      .filter(Boolean),
  }));
}

function upsertReadme(readmePath, section) {
  const path = resolve(process.cwd(), readmePath);
  const body = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = upsertMarkedSection(body, section);
  writeFileSync(path, next.endsWith("\n") ? next : next + "\n", "utf8");
  return path;
}

function getCurrentPr(repo, branch) {
  // With --repo, gh requires an explicit number/url/branch argument.
  const raw = run("gh", [
    "pr",
    "view",
    branch,
    "--repo",
    repo,
    "--json",
    "number,title,body,url,headRefName,baseRefName,state,isDraft,author,labels",
  ]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die("Failed to parse `gh pr view` JSON.");
  }
  return {
    number: parsed.number,
    title: parsed.title,
    headRefName: parsed.headRefName,
    baseRefName: parsed.baseRefName,
    url: parsed.url,
    state: parsed.state,
    isDraft: Boolean(parsed.isDraft),
    authorLogin: parsed.author?.login ?? "",
    labels: (parsed.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name))
      .filter(Boolean),
    body: parsed.body ?? "",
  };
}

function updatePrBody(repo, prNumber, body) {
  const tmp = join(
    dirname(fileURLToPath(import.meta.url)),
    `.pr-body-${prNumber}.tmp.md`
  );
  try {
    writeFileSync(tmp, body, "utf8");
    run("gh", [
      "pr",
      "edit",
      String(prNumber),
      "--repo",
      repo,
      "--body-file",
      tmp,
    ]);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function main() {
  const libPath = join(dirname(fileURLToPath(import.meta.url)), "lib", "stackMapper.js");
  if (!existsSync(libPath)) {
    die(
      `Missing ${libPath}. From the pull-request-mapper repo run: npm run compile`
    );
  }

  const opts = parseArgs(process.argv.slice(2));
  ensureGh();

  const filters = {
    maxDepth: opts.maxDepth,
    excludeDrafts: opts.excludeDrafts,
    authorFilter: opts.authorFilter,
    labelFilter: opts.labelFilter,
  };

  const branch = getBranch();
  const repo = getRepo();
  let prs = filterPullRequests(listPrs(repo, opts.closed), filters);

  let current = null;
  if (opts.prBody) {
    current = getCurrentPr(repo, branch);
    if (!prs.some((p) => p.number === current.number)) {
      prs = [...prs, current];
    }
  }

  if (prs.length === 0) {
    die(
      opts.closed === "exclude"
        ? `No matching open pull requests in ${repo}.`
        : `No matching pull requests in ${repo}.`
    );
  }

  let highlight;
  if (opts.prBody) {
    highlight =
      prs.find((p) => p.number === current.number) ?? current;
  } else if (opts.highlight) {
    highlight = prs.find((p) => p.number === opts.highlight);
  } else {
    highlight = prs.find((p) => p.headRefName === branch);
  }

  if (!highlight && opts.highlight) {
    die(`No PR #${opts.highlight} in the filtered set.`);
  }
  if (!highlight) {
    die(
      `No PR found for checked-out branch \`${branch}\` in ${repo}. Pass --highlight <n> or check out a PR branch.`
    );
  }

  let root = opts.root
    ? prs.find((p) => p.number === opts.root)
    : findStackRoot(highlight, prs);

  if (!root) die(`No PR #${opts.root} in the filtered set.`);

  const tree = buildStackTree(root, prs, filters);
  const section = renderReadmeSection(tree, highlight, opts.closed);

  if (opts.prBody) {
    const nextBody = upsertMarkedSection(current.body, section);
    updatePrBody(repo, current.number, nextBody);
    console.error(`Updated PR #${current.number} description (${current.url})`);
  }

  if (opts.readme) {
    const path = upsertReadme(opts.readme, section);
    console.error(`Updated ${path}`);
  }

  if (opts.stdout || (!opts.readme && !opts.prBody)) {
    process.stdout.write(section.endsWith("\n") ? section : section + "\n");
  }
}

main();
