import * as vscode from "vscode";
import * as path from "path";
import {
  GhError,
  ensureGhReady,
  getCurrentBranchName,
  getCurrentBranchPullRequest,
  getRepoNameWithOwner,
  isOpenPullRequest,
  listPullRequests,
  updatePullRequestBody,
  type PullRequest,
} from "./gh";
import {
  buildStackTree,
  enumerateDiagramNodes,
  filterPullRequests,
  findStackRoot,
  isReadmeFileName,
  renderMarkdownDocument,
  renderReadmeSection,
  upsertMarkedSection,
  type DiagramNode,
} from "./stackMapper";
import {
  getClosedPullRequestsMode,
  getStackFilters,
  type ClosedPullRequestsMode,
} from "./settings";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pull-request-mapper.mapPrStack",
      async () => {
        await mapPrStack();
      }
    ),
    vscode.commands.registerCommand(
      "pull-request-mapper.upsertCurrentPrDescription",
      async () => {
        await upsertCurrentPrDescription();
      }
    )
  );
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
  const filters = getStackFilters();
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

  pullRequests = filterPullRequests(pullRequests, filters);

  if (pullRequests.length === 0) {
    void vscode.window.showInformationMessage(
      closedMode === "exclude"
        ? `No matching open pull requests found in ${repo}.`
        : `No matching pull requests found in ${repo}.`
    );
    return;
  }

  const selected = await pickPullRequest(pullRequests, repo, closedMode);
  if (!selected) {
    return;
  }

  const tree = buildStackTree(selected, pullRequests, filters);
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

  const destination = await pickDestination();
  if (!destination) {
    return;
  }

  if (destination === "tab") {
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
    return;
  }

  const readmeUri = await pickReadmeFile();
  if (!readmeUri) {
    return;
  }

  const section = renderReadmeSection(tree, highlight.pr, closedMode);

  try {
    const existing = await readFileText(readmeUri);
    const next = upsertMarkedSection(existing, section);
    await vscode.workspace.fs.writeFile(
      readmeUri,
      Buffer.from(next, "utf8")
    );
    const doc = await vscode.workspace.openTextDocument(readmeUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage(
      `PR stack diagram updated in ${path.basename(readmeUri.fsPath)}.`
    );
  } catch (error) {
    void vscode.window.showErrorMessage(messageFrom(error));
  }
}

/**
 * One-shot: map the stack containing the current branch’s PR, highlight that PR,
 * and upsert the Mermaid block into its GitHub description via `gh pr edit`.
 * No highlight / root / destination prompts.
 */
async function upsertCurrentPrDescription(): Promise<void> {
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
  const filters = getStackFilters();
  const listState = closedMode === "exclude" ? "open" : "all";

  try {
    const repo = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PR Mapper: loading repository…",
        cancellable: false,
      },
      async () => getRepoNameWithOwner(cwd)
    );

    const current = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PR Mapper: loading PR for current branch…",
        cancellable: false,
      },
      async () => getCurrentBranchPullRequest(cwd, repo)
    );

    let pullRequests = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `PR Mapper: listing PRs for ${repo}…`,
        cancellable: false,
      },
      async () => listPullRequests(cwd, repo, listState)
    );

    pullRequests = filterPullRequests(pullRequests, filters);
    if (!pullRequests.some((p) => p.number === current.number)) {
      pullRequests = [...pullRequests, current];
    }

    const highlight =
      pullRequests.find((p) => p.number === current.number) ?? current;
    const root = findStackRoot(highlight, pullRequests);
    const tree = buildStackTree(root, pullRequests, filters);
    const section = renderReadmeSection(tree, highlight, closedMode);
    const nextBody = upsertMarkedSection(current.body, section);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `PR Mapper: updating description of #${current.number}…`,
        cancellable: false,
      },
      async () => updatePullRequestBody(cwd, repo, current.number, nextBody)
    );

    void vscode.window.showInformationMessage(
      `PR stack diagram upserted into #${current.number} description.`,
      "Open PR"
    ).then((choice) => {
      if (choice === "Open PR") {
        void vscode.env.openExternal(vscode.Uri.parse(current.url));
      }
    });
  } catch (error) {
    void vscode.window.showErrorMessage(messageFrom(error));
  }
}

function getWorkspaceCwd(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

async function pickDestination(): Promise<"tab" | "readme" | undefined> {
  type Item = vscode.QuickPickItem & { id: "tab" | "readme" };
  const picked = await vscode.window.showQuickPick<Item>(
    [
      {
        label: "Open Markdown tab",
        description: "Preview the full diagram document",
        id: "tab",
      },
      {
        label: "Insert or update to README",
        description: "Upsert the marked Mermaid block into a README file",
        id: "readme",
      },
    ],
    {
      title: "PR Mapper output",
      placeHolder: "Choose where to put the diagram",
    }
  );
  return picked?.id;
}

async function pickReadmeFile(): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }

  const entries = await vscode.workspace.fs.readDirectory(folder.uri);
  const readmes = entries
    .filter(
      ([name, type]) =>
        type === vscode.FileType.File && isReadmeFileName(name)
    )
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  if (readmes.length === 0) {
    const create = await vscode.window.showQuickPick(
      [
        { label: "Create README.md", id: "create" as const },
        { label: "Cancel", id: "cancel" as const },
      ],
      { title: "No README file found in the workspace root" }
    );
    if (create?.id !== "create") {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, "README.md");
  }

  if (readmes.length === 1) {
    return vscode.Uri.joinPath(folder.uri, readmes[0]);
  }

  const picked = await vscode.window.showQuickPick(
    readmes.map((name) => ({ label: name, description: "workspace root" })),
    {
      title: "Select README to update",
      placeHolder: "Matching README / README.* in the workspace root",
    }
  );
  if (!picked) {
    return undefined;
  }
  return vscode.Uri.joinPath(folder.uri, picked.label);
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return "";
  }
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
