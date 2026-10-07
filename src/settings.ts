import * as vscode from "vscode";
import {
  DEFAULT_STACK_FILTERS,
  type ClosedPullRequestsMode,
  type StackFilters,
} from "./stackMapper";

export type { ClosedPullRequestsMode, StackFilters };

const SECTION = "pullRequestMapper";

export function getClosedPullRequestsMode(): ClosedPullRequestsMode {
  const value = vscode.workspace
    .getConfiguration(SECTION)
    .get<string>("closedPullRequests", "exclude");

  if (value === "grayedOut" || value === "normal" || value === "exclude") {
    return value;
  }
  return "exclude";
}

export function getStackFilters(): StackFilters {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const maxDepth = cfg.get<number>("maxDepth", DEFAULT_STACK_FILTERS.maxDepth);
  const excludeDrafts = cfg.get<boolean>(
    "excludeDrafts",
    DEFAULT_STACK_FILTERS.excludeDrafts
  );
  const authorFilter = cfg.get<string>(
    "authorFilter",
    DEFAULT_STACK_FILTERS.authorFilter
  );
  const labelFilter = cfg.get<string>(
    "labelFilter",
    DEFAULT_STACK_FILTERS.labelFilter
  );

  return {
    maxDepth: Number.isFinite(maxDepth) && maxDepth >= 0 ? maxDepth : 0,
    excludeDrafts: Boolean(excludeDrafts),
    authorFilter: authorFilter ?? "",
    labelFilter: labelFilter ?? "",
  };
}
