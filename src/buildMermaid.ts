/**
 * Re-exports shared stack → Mermaid helpers (kept for stable import paths).
 */
export {
  buildStackTree,
  countClosedNodes,
  countNodes,
  enumerateDiagramNodes,
  filterPullRequests,
  findStackRoot,
  isOpenPullRequest,
  isReadmeFileName,
  renderMarkdownDocument,
  renderMermaid,
  renderReadmeSection,
  upsertMarkedSection,
  upsertReadmeSection,
  DEFAULT_STACK_FILTERS,
  MARKER_END,
  MARKER_START,
  type ClosedPullRequestsMode,
  type DiagramNode,
  type PullRequest,
  type StackFilters,
  type StackNode,
} from "./stackMapper";
