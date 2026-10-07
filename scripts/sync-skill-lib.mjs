#!/usr/bin/env node
/**
 * Copy compiled stackMapper.js into the Cursor skill so agents use the same logic.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "out", "stackMapper.js");
const destDir = join(
  root,
  ".cursor",
  "skills",
  "pr-stack-mermaid",
  "scripts",
  "lib"
);
const dest = join(destDir, "stackMapper.js");

if (!existsSync(src)) {
  console.error(`sync-skill-lib: missing ${src}; run npm run compile first`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`sync-skill-lib: wrote ${dest}`);
