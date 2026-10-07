import * as vscode from "vscode";
import {
  GhError,
  ensureGhReady,
  getCurrentBranchName,
  getRepoNameWithOwner,
  isOpenPullRequest,
  listPullRequests,
  type PullRequest,
} from "./gh";
import {
  buildStackTree,
  enumerateDiagramNodes,
  renderMarkdownDocument,
  type DiagramNode,
} from "./buildMermaid";
import {
  getClosedPullRequestsMode,
  type ClosedPullRequestsMode,
} from "./settings";

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

  const closedMode = getClosedPullRequestsMode();
  const listState = closedMode === "exclude" ? "open" : "all";

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

    const listLabel =
      listState === "open" ? "listing open PRs" : "listing open and closed PRs";

    pullRequests = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `PR Mapper: ${listLabel} for ${repo}…`,
        cancellable: false,
      },
      async () => listPullRequests(cwd, repo, listState)
    );
  } catch (error) {
    void vscode.window.showErrorMessage(messageFrom(error));
    return;
  }

  if (pullRequests.length === 0) {
    void vscode.window.showInformationMessage(
      closedMode === "exclude"
        ? `No open pull requests found in ${repo}.`
        : `No pull requests found in ${repo}.`
    );
    return;
  }

  const selected = await pickPullRequest(pullRequests, repo, closedMode);
  if (!selected) {
    return;
  }

  const tree = buildStackTree(selected, pullRequests);
  const diagramNodes = enumerateDiagramNodes(tree);
  const checkedOutBranch = await getCurrentBranchName(cwd);

  const highlight = await pickHighlightNode(
    diagramNodes,
    selected,
    checkedOutBranch
  );
  if (!highlight) {
    return;
  }

  const markdown = renderMarkdownDocument(
    tree,
    repo,
    selected,
    highlight.pr,
    closedMode
  );

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
  repo: string,
  closedMode: ClosedPullRequestsMode
): Promise<PullRequest | undefined> {
  const sorted = [...pullRequests].sort((a, b) => b.number - a.number);

  type Item = vscode.QuickPickItem & { pr: PullRequest };
  const items: Item[] = sorted.map((pr) => ({
    label: `#${pr.number} ${pr.title}`,
    description: pr.headRefName,
    detail:
      closedMode === "exclude"
        ? `base: ${pr.baseRefName}`
        : `base: ${pr.baseRefName} · ${pr.state.toLowerCase()}`,
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

/** Pick which diagram node gets `style <letter> …` (current PR for the description). */
async function pickHighlightNode(
  nodes: DiagramNode[],
  root: PullRequest,
  checkedOutBranch: string | undefined
): Promise<DiagramNode | undefined> {
  type Item = vscode.QuickPickItem & { node: DiagramNode };
  const items: Item[] = nodes.map((node) => {
    const stateNote = isOpenPullRequest(node.pr)
      ? ""
      : ` · ${node.pr.state.toLowerCase()}`;
    const onCheckout =
      checkedOutBranch !== undefined &&
      node.pr.headRefName === checkedOutBranch;
    const roleNote =
      node.pr.number === root.number
        ? "stack root (map target)"
        : `base: ${node.pr.baseRefName}`;
    const checkoutNote = onCheckout ? " · checked-out branch" : "";
    return {
      label: `${node.id} — #${node.pr.number} ${node.pr.title}`,
      description: node.pr.headRefName,
      detail: `${roleNote}${stateNote}${checkoutNote}`,
      node,
    };
  });

  const quickPick = vscode.window.createQuickPick<Item>();
  quickPick.title = "Highlight current PR in the diagram";
  quickPick.placeholder =
    "Node letter used in the final Mermaid style line (for the PR description you will paste into)";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.items = items;

  const onCheckoutItem =
    checkedOutBranch !== undefined
      ? items.find((item) => item.node.pr.headRefName === checkedOutBranch)
      : undefined;
  const preferred =
    onCheckoutItem ??
    items.find((item) => item.node.pr.number === root.number) ??
    items[0];
  if (preferred) {
    quickPick.activeItems = [preferred];
  }

  return new Promise((resolve) => {
    const disposables: vscode.Disposable[] = [];
    let settled = false;
    const finish = (node: DiagramNode | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const d of disposables) {
        d.dispose();
      }
      quickPick.hide();
      quickPick.dispose();
      resolve(node);
    };
    disposables.push(
      quickPick.onDidAccept(() => {
        finish(
          quickPick.selectedItems[0]?.node ?? quickPick.activeItems[0]?.node
        );
      }),
      quickPick.onDidHide(() => {
        finish(undefined);
      })
    );
    quickPick.show();
  });
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
