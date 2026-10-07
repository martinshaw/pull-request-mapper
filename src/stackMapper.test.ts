import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_STACK_FILTERS,
  buildStackTree,
  countNodes,
  escapeLabel,
  filterPullRequests,
  findStackRoot,
  isBranchOnlyRoot,
  isReadmeFileName,
  makeBranchRoot,
  renderMermaid,
  upsertReadmeSection,
  MARKER_END,
  MARKER_START,
  type PullRequest,
} from "./stackMapper";

/** Synthetic fixture — fictional org/repo only. */
function pr(
  partial: Partial<PullRequest> &
    Pick<PullRequest, "number" | "title" | "headRefName" | "baseRefName">
): PullRequest {
  return {
    url: `https://github.com/example/stacked-demo/pull/${partial.number}`,
    state: "OPEN",
    isDraft: false,
    authorLogin: "dev-a",
    labels: [],
    ...partial,
  };
}

const fixture: PullRequest[] = [
  pr({
    number: 1,
    title: "[L1] Stack A",
    headRefName: "stack/L1-A",
    baseRefName: "main",
  }),
  pr({
    number: 3,
    title: "[L2] Stack A1",
    headRefName: "stack/L2-A1",
    baseRefName: "stack/L1-A",
  }),
  pr({
    number: 7,
    title: "[L3] Stack A11",
    headRefName: "stack/L3-A11",
    baseRefName: "stack/L2-A1",
  }),
  pr({
    number: 15,
    title: "[L4] Stack A111",
    headRefName: "stack/L4-A111",
    baseRefName: "stack/L3-A11",
  }),
  pr({
    number: 16,
    title: "[L4] Stack A112",
    headRefName: "stack/L4-A112",
    baseRefName: "stack/L3-A11",
  }),
  pr({
    number: 22,
    title: "[L4] Stack A222",
    headRefName: "stack/L4-A222",
    baseRefName: "stack/L3-A22",
    state: "CLOSED",
  }),
  pr({
    number: 10,
    title: "[L3] Stack A22",
    headRefName: "stack/L3-A22",
    baseRefName: "stack/L2-A2",
  }),
  pr({
    number: 4,
    title: "[L2] Stack A2",
    headRefName: "stack/L2-A2",
    baseRefName: "stack/L1-A",
  }),
  pr({
    number: 99,
    title: "Draft leaf",
    headRefName: "stack/draft",
    baseRefName: "stack/L1-A",
    isDraft: true,
    authorLogin: "dev-b",
    labels: ["wip"],
  }),
];

describe("findStackRoot", () => {
  it("walks up to the top of the stack", () => {
    const leaf = fixture.find((p) => p.number === 15)!;
    const root = findStackRoot(leaf, fixture);
    assert.equal(root.number, 1);
  });
});

describe("buildStackTree", () => {
  it("with default filters maps the full dependent tree", () => {
    const root = fixture.find((p) => p.number === 1)!;
    const tree = buildStackTree(root, fixture, DEFAULT_STACK_FILTERS);
    assert.equal(countNodes(tree), 9);
    assert.equal(tree.children.length, 3);
  });

  it("respects maxDepth (levels below root)", () => {
    const root = fixture.find((p) => p.number === 1)!;
    const tree = buildStackTree(root, fixture, {
      ...DEFAULT_STACK_FILTERS,
      maxDepth: 1,
    });
    assert.equal(tree.children.length, 3);
    for (const child of tree.children) {
      assert.equal(child.children.length, 0);
    }
  });

  it("maps dependents from a branch-only root (no PR)", () => {
    const branchRoot = makeBranchRoot(
      "main",
      "https://github.com/example/stacked-demo/tree/main"
    );
    assert.equal(isBranchOnlyRoot(branchRoot), true);
    const tree = buildStackTree(branchRoot, fixture, DEFAULT_STACK_FILTERS);
    assert.equal(tree.pr.headRefName, "main");
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0].pr.number, 1);
    const mermaid = renderMermaid(tree, {
      highlightNumber: 0,
      closedPullRequests: "grayedOut",
    });
    assert.match(mermaid, /branch · no PR/);
    assert.doesNotMatch(mermaid, /style A fill:#e8e8e8/);
    assert.match(mermaid, /style A stroke-width:5px/);
  });
});

describe("filterPullRequests", () => {
  it("defaults keep every PR", () => {
    assert.equal(
      filterPullRequests(fixture, DEFAULT_STACK_FILTERS).length,
      fixture.length
    );
  });

  it("excludeDrafts removes drafts only", () => {
    const filtered = filterPullRequests(fixture, {
      ...DEFAULT_STACK_FILTERS,
      excludeDrafts: true,
    });
    assert.equal(filtered.some((p) => p.isDraft), false);
    assert.equal(filtered.length, fixture.length - 1);
  });

  it("authorFilter matches login", () => {
    const filtered = filterPullRequests(fixture, {
      ...DEFAULT_STACK_FILTERS,
      authorFilter: "dev-b",
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].number, 99);
  });

  it("labelFilter matches label name", () => {
    const filtered = filterPullRequests(fixture, {
      ...DEFAULT_STACK_FILTERS,
      labelFilter: "wip",
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].number, 99);
  });
});

describe("escapeLabel / renderMermaid", () => {
  it("escapes special characters and uses literal \\n", () => {
    assert.equal(escapeLabel('A "B" #1'), "A #quot;B#quot; #35;1");
    const root = fixture.find((p) => p.number === 1)!;
    const openOnly = filterPullRequests(
      fixture.filter((p) => p.state === "OPEN" && !p.isDraft),
      DEFAULT_STACK_FILTERS
    );
    // Rebuild a tiny tree for stable assertions
    const tiny = [
      root,
      fixture.find((p) => p.number === 3)!,
      fixture.find((p) => p.number === 22)!,
      fixture.find((p) => p.number === 10)!,
      fixture.find((p) => p.number === 4)!,
    ];
    const tree = buildStackTree(root, tiny, DEFAULT_STACK_FILTERS);
    const mermaid = renderMermaid(tree, {
      highlightNumber: 1,
      closedPullRequests: "grayedOut",
    });
    assert.match(mermaid, /\\n\\n/);
    assert.doesNotMatch(mermaid, /\nstack\//);
    assert.match(mermaid, /style A stroke-width:5px/);
    assert.match(mermaid, /example\/stacked-demo/);
    assert.doesNotMatch(mermaid, /martinshaw/i);
  });
});

describe("upsertReadmeSection", () => {
  it("inserts at top when markers are absent", () => {
    const section = `${MARKER_START}\n\`\`\`mermaid\nflowchart TB\n  A["x"]\n\`\`\`\n${MARKER_END}\n`;
    const next = upsertReadmeSection("# Title\n\nBody\n", section);
    assert.ok(next.startsWith(MARKER_START));
    assert.ok(next.includes("```mermaid"));
    assert.ok(next.includes("# Title"));
  });

  it("replaces an existing marked block", () => {
    const oldSection = `${MARKER_START}\nold\n${MARKER_END}\n`;
    const newSection = `${MARKER_START}\nnew\n${MARKER_END}\n`;
    const body = `${oldSection}\n# Title\n`;
    const next = upsertReadmeSection(body, newSection);
    assert.ok(next.includes("new"));
    assert.equal(next.includes("old"), false);
    assert.ok(next.includes("# Title"));
  });
});

describe("isReadmeFileName", () => {
  it("accepts common README names", () => {
    for (const name of [
      "README",
      "README.md",
      "readme.markdown",
      "Readme.mdown",
      "README.mkd",
      "README.txt",
    ]) {
      assert.equal(isReadmeFileName(name), true, name);
    }
    assert.equal(isReadmeFileName("CHANGELOG.md"), false);
    assert.equal(isReadmeFileName("readme.js"), false);
  });
});
