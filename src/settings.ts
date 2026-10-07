import * as vscode from "vscode";

/** How non-open PRs are handled in the stack diagram. */
export type ClosedPullRequestsMode = "exclude" | "grayedOut" | "normal";

const SETTING_KEY = "closedPullRequests";
const SECTION = "pullRequestMapper";

export function getClosedPullRequestsMode(): ClosedPullRequestsMode {
  const value = vscode.workspace
    .getConfiguration(SECTION)
    .get<string>(SETTING_KEY, "exclude");

  if (value === "grayedOut" || value === "normal" || value === "exclude") {
    return value;
  }
  return "exclude";
}
