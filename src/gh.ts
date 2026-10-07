import { execFile } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import type { PullRequest } from "./stackMapper";

export type { PullRequest } from "./stackMapper";
export { isOpenPullRequest } from "./stackMapper";

const execFileAsync = promisify(execFile);

export type PullRequestWithBody = PullRequest & { body: string };

export class GhError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhError";
  }
}

async function runGh(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("gh", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    if (err.code === "ENOENT") {
      throw new GhError(
        "GitHub CLI (`gh`) is not installed or not on PATH. Install it from https://cli.github.com/ and try again."
      );
    }
    const detail = (err.stderr || err.stdout || err.message || "").trim();
    throw new GhError(detail || "GitHub CLI command failed.");
  }
}

/** Returns true when `gh` is installed and the current user is authenticated. */
export async function ensureGhReady(cwd: string): Promise<void> {
  try {
    await execFileAsync("gh", ["--version"], {
      cwd,
      env: process.env,
    });
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new GhError(
        "GitHub CLI (`gh`) is not installed or not on PATH. Install it from https://cli.github.com/ and try again."
      );
    }
    throw new GhError("Could not run GitHub CLI (`gh`).");
  }

  try {
    await execFileAsync("gh", ["auth", "status"], {
      cwd,
      env: process.env,
    });
  } catch {
    throw new GhError(
      "GitHub CLI is not authenticated. Run `gh auth login` in a terminal, then try again."
    );
  }
}

/**
 * Current checkout branch name, or `undefined` if detached / unavailable.
 * Local `git` only — not a GitHub API call.
 */
export async function getCurrentBranchName(
  cwd: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, env: process.env }
    );
    const branch = stdout.trim();
    if (!branch || branch === "HEAD") {
      return undefined;
    }
    return branch;
  } catch {
    return undefined;
  }
}

/** Resolve the GitHub owner/name for the workspace git remote (one `gh` call). */
export async function getRepoNameWithOwner(cwd: string): Promise<string> {
  const { stdout } = await runGh(
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd
  );
  const repo = stdout.trim();
  if (!repo) {
    throw new GhError(
      "Could not determine the GitHub repository for this workspace. Open a folder that is a git clone with a GitHub remote."
    );
  }
  return repo;
}

export type PrListState = "open" | "all";

type GhPrJson = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  state: string;
  isDraft?: boolean;
  author?: { login?: string } | null;
  labels?: Array<{ name?: string } | string> | null;
};

function normalizePr(raw: GhPrJson): PullRequest {
  const labels = (raw.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((n): n is string => Boolean(n));

  return {
    number: raw.number,
    title: raw.title,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    url: raw.url,
    state: raw.state,
    isDraft: Boolean(raw.isDraft),
    authorLogin: raw.author?.login ?? "",
    labels,
  };
}

/**
 * Fetch PRs for the workspace repo in a single `gh pr list` call.
 * All stack mapping is done locally from this list.
 */
export async function listPullRequests(
  cwd: string,
  repo: string,
  state: PrListState = "open"
): Promise<PullRequest[]> {
  const { stdout } = await runGh(
    [
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
    ],
    cwd
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as GhPrJson[];
    return parsed.map(normalizePr);
  } catch {
    throw new GhError("Failed to parse `gh pr list` JSON output.");
  }
}

type GhPrViewJson = GhPrJson & { body?: string | null };

/**
 * PR for the current branch (`gh pr view`), including description body.
 */
export async function getCurrentBranchPullRequest(
  cwd: string,
  repo: string
): Promise<PullRequestWithBody> {
  try {
    const { stdout } = await runGh(
      [
        "pr",
        "view",
        "--repo",
        repo,
        "--json",
        "number,title,body,url,headRefName,baseRefName,state,isDraft,author,labels",
      ],
      cwd
    );
    const raw = JSON.parse(stdout) as GhPrViewJson;
    return {
      ...normalizePr(raw),
      body: raw.body ?? "",
    };
  } catch (error: unknown) {
    if (error instanceof GhError) {
      throw new GhError(
        `${error.message}\n\nCheck out a branch that has an open (or existing) pull request, then try again.`
      );
    }
    throw error;
  }
}

/** Replace a pull request description via `gh pr edit --body-file` (gh only). */
export async function updatePullRequestBody(
  cwd: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const tmpPath = join(
    tmpdir(),
    `pr-mapper-body-${repo.replace(/[^\w.-]+/g, "_")}-${prNumber}.md`
  );
  try {
    await fs.writeFile(tmpPath, body, "utf8");
    await runGh(
      [
        "pr",
        "edit",
        String(prNumber),
        "--repo",
        repo,
        "--body-file",
        tmpPath,
      ],
      cwd
    );
  } finally {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
