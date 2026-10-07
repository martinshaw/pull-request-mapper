import * as vscode from "vscode";
import {
  GhError,
  ensureGhReady,
  getRepoNameWithOwner,
  listOpenPullRequests,
  type PullRequest,
} from "./gh";
import { buildStackTree, renderMarkdownDocument } from "./buildMermaid";

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    "pull-request-mapper.mapPrStack",
    async () => {
      await mapPrStack();
    }
  );
  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // nothing to clean up
}

async function mapPrStack(): Promise<void> {
  const cwd = getWorkspaceCwd();
  if (!cwd) {
    void vscode.window.showErrorMessage(
      "Open a folder that is a git repository before mapping PR stacks."
    );
    return;
  }

  try {
    await ensureGhReady(cwd);
  } catch (error) {
    void vscode.window.showErrorMessage(messageFrom(error));
    return;
  }

  let repo: string;
  let pullRequests: PullRequest[];

  try {
    repo = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PR Mapper: loading repository…",
        cancellable: false,
      },
      async () => getRepoNameWithOwner(cwd)
    );

    pullRequests = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `PR Mapper: listing open PRs for ${repo}…`,
        cancellable: false,
      },
      async () => listOpenPullRequests(cwd, repo)
    );
  } catch (error) {
    void vscode.window.showErrorMessage(messageFrom(error));
    return;
  }

  if (pullRequests.length === 0) {
    void vscode.window.showInformationMessage(
      `No open pull requests found in ${repo}.`
    );
    return;
  }

  const selected = await pickPullRequest(pullRequests, repo);
  if (!selected) {
    return;
  }

  const tree = buildStackTree(selected, pullRequests);
  const markdown = renderMarkdownDocument(tree, repo, selected);

  const doc = await vscode.workspace.openTextDocument({
    content: markdown,
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

function getWorkspaceCwd(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

async function pickPullRequest(
  pullRequests: PullRequest[],
  repo: string
): Promise<PullRequest | undefined> {
  const sorted = [...pullRequests].sort((a, b) => b.number - a.number);

  type Item = vscode.QuickPickItem & { pr: PullRequest };
  const items: Item[] = sorted.map((pr) => ({
    label: `#${pr.number} ${pr.title}`,
    description: pr.headRefName,
    detail: `base: ${pr.baseRefName}`,
    pr,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `Select a PR to map (${repo})`,
    placeHolder: "PRs whose base is this PR's branch will appear as dependents",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return picked?.pr;
}

function messageFrom(error: unknown): string {
  if (error instanceof GhError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
