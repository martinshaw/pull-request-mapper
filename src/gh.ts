import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type PullRequest = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  state: string;
};

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

/**
 * Fetch open PRs for the workspace repo in a single `gh pr list` call.
 * All stack mapping is done locally from this list.
 */
export async function listOpenPullRequests(
  cwd: string,
  repo: string
): Promise<PullRequest[]> {
  const { stdout } = await runGh(
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,title,headRefName,baseRefName,url,state",
    ],
    cwd
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    return JSON.parse(trimmed) as PullRequest[];
  } catch {
    throw new GhError("Failed to parse `gh pr list` JSON output.");
  }
}
