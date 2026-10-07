import * as vscode from "vscode";
import * as path from "path";
import {
  GhError,
  ensureGhReady,
  getCurrentBranchName,
  getCurrentBranchPullRequest,
  getRepoNameWithOwner,
  githubBranchTreeUrl,
  isOpenPullRequest,
  listPullRequests,
  searchBranches,
  searchPullRequests,
  updatePullRequestBody,
  type PullRequest,
} from "./gh";
import {
  buildStackTree,
  enumerateDiagramNodes,
  filterPullRequests,
  findStackRoot,
  isBranchOnlyRoot,
  isReadmeFileName,
  makeBranchRoot,
  renderMarkdownDocument,
  renderReadmeSection,
  upsertMarkedSection,
  type DiagramNode,
} from "./stackMapper";
import { getClosedPullRequestsMode, getStackFilters } from "./settings";

const ROOT_SEARCH_DEBOUNCE_MS = 280;
const ROOT_SEARCH_LIMIT = 20;

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

  let repo: string;
  try {
    repo = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PR Mapper: loading repository…",
        cancellable: false,
      },
      async () => getRepoNameWithOwner(cwd)
    );
  } catch (error) {
    void vscode.window.showErrorMessage(messageFrom(error));
    return;
  }

  const selected = await pickStackRoot(cwd, repo, filters);
  if (!selected) {
    return;
  }

  // Load dependents after root choice (search picker does not prefetch the full list).
  const listState = closedMode === "exclude" ? "open" : "all";
  let treePrs: PullRequest[];
  try {
    treePrs = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:
          listState === "open"
            ? `PR Mapper: listing open PRs for ${repo}…`
            : `PR Mapper: listing open and closed PRs for ${repo}…`,
        cancellable: false,
      },
      async () =>
        filterPullRequests(
          await listPullRequests(cwd, repo, listState),
          filters
        )
    );
  } catch (error) {
    void vscode.window.showErrorMessage(messageFrom(error));
    return;
  }

  const tree = buildStackTree(selected, treePrs, filters);
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

/**
 * Empty until the user types; then searches PRs (`gh pr list --search`) and
 * remote branches (GraphQL via `gh api`). Branches that already have a PR in
 * the result set are omitted so "branch · no PR" is only offered when true.
 */
async function pickStackRoot(
  cwd: string,
  repo: string,
  filters: ReturnType<typeof getStackFilters>
): Promise<PullRequest | undefined> {
  type Item = vscode.QuickPickItem & { pr: PullRequest };

  const quickPick = vscode.window.createQuickPick<Item>();
  quickPick.title = `Select stack root (${repo})`;
  quickPick.placeholder =
    "Type to search open/closed PRs and branches without a PR";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.items = [];
  quickPick.busy = false;

  return new Promise((resolve) => {
    const disposables: vscode.Disposable[] = [];
    let settled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let searchGeneration = 0;

    const finish = (pr: PullRequest | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      searchGeneration += 1;
      for (const d of disposables) {
        d.dispose();
      }
      quickPick.hide();
      quickPick.dispose();
      resolve(pr);
    };

    const runSearch = async (rawQuery: string): Promise<void> => {
      const query = rawQuery.trim();
      const generation = ++searchGeneration;

      if (!query) {
        quickPick.busy = false;
        quickPick.items = [];
        return;
      }

      quickPick.busy = true;
      try {
        const [prs, branches] = await Promise.all([
          searchPullRequests(cwd, repo, query, ROOT_SEARCH_LIMIT),
          searchBranches(cwd, repo, query, ROOT_SEARCH_LIMIT),
        ]);
        if (generation !== searchGeneration || settled) {
          return;
        }

        const filteredPrs = filterPullRequests(prs, filters);
        const prHeadNames = new Set(
          filteredPrs.map((pr) => pr.headRefName.toLowerCase())
        );

        // alwaysShow: avoid VS Code re-filtering away gh search hits.
        const prItems: Item[] = filteredPrs.map((pr) => ({
          label: `#${pr.number} ${pr.title}`,
          description: pr.headRefName,
          detail: `PR · base: ${pr.baseRefName} · ${pr.state.toLowerCase()}`,
          alwaysShow: true,
          pr,
        }));

        const branchItems: Item[] = branches
          .filter((name) => !prHeadNames.has(name.toLowerCase()))
          .map((name) => {
            const pr = makeBranchRoot(name, githubBranchTreeUrl(repo, name));
            return {
              label: name,
              description: "branch",
              detail: "Branch · no pull request — use as stack root",
              alwaysShow: true,
              pr,
            };
          });

        quickPick.items = [...prItems, ...branchItems];
      } catch (error) {
        if (generation !== searchGeneration || settled) {
          return;
        }
        quickPick.items = [];
        void vscode.window.showErrorMessage(messageFrom(error));
      } finally {
        if (generation === searchGeneration) {
          quickPick.busy = false;
        }
      }
    };

    disposables.push(
      quickPick.onDidChangeValue((value) => {
        if (debounceTimer !== undefined) {
          clearTimeout(debounceTimer);
        }
        if (!value.trim()) {
          searchGeneration += 1;
          quickPick.busy = false;
          quickPick.items = [];
          return;
        }
        debounceTimer = setTimeout(() => {
          void runSearch(value);
        }, ROOT_SEARCH_DEBOUNCE_MS);
      }),
      quickPick.onDidAccept(() => {
        finish(
          quickPick.selectedItems[0]?.pr ?? quickPick.activeItems[0]?.pr
        );
      }),
      quickPick.onDidHide(() => {
        finish(undefined);
      })
    );

    quickPick.show();
  });
}

/** Pick which diagram node gets `style <letter> …` (current PR for the description). */
async function pickHighlightNode(
  nodes: DiagramNode[],
  root: PullRequest,
  checkedOutBranch: string | undefined
): Promise<DiagramNode | undefined> {
  type Item = vscode.QuickPickItem & { node: DiagramNode };
  const items: Item[] = nodes.map((node) => {
    const stateNote = isBranchOnlyRoot(node.pr)
      ? " · branch"
      : isOpenPullRequest(node.pr)
        ? ""
        : ` · ${node.pr.state.toLowerCase()}`;
    const onCheckout =
      checkedOutBranch !== undefined &&
      node.pr.headRefName === checkedOutBranch;
    const isRoot =
      isBranchOnlyRoot(root) && isBranchOnlyRoot(node.pr)
        ? node.pr.headRefName === root.headRefName
        : node.pr.number === root.number;
    const roleNote = isRoot
      ? "stack root (map target)"
      : isBranchOnlyRoot(node.pr)
        ? "branch · no PR"
        : `base: ${node.pr.baseRefName}`;
    const checkoutNote = onCheckout ? " · checked-out branch" : "";
    const label = isBranchOnlyRoot(node.pr)
      ? `${node.id} — ${node.pr.headRefName}`
      : `${node.id} — #${node.pr.number} ${node.pr.title}`;
    return {
      label,
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
  const rootItem = items.find((item) =>
    isBranchOnlyRoot(root)
      ? isBranchOnlyRoot(item.node.pr) &&
        item.node.pr.headRefName === root.headRefName
      : item.node.pr.number === root.number
  );
  const preferred = onCheckoutItem ?? rootItem ?? items[0];
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
