import test from "node:test";
import assert from "node:assert/strict";
import { fetchKnowledge } from "../lib/repository-index";

test("rejects paths outside knowledge roots", async () => {
  await assert.rejects(() => fetchKnowledge({ path: "package.json" }), /Path must be a Markdown file/);
});

test("rejects path traversal", async () => {
  await assert.rejects(() => fetchKnowledge({ path: "curriculum/../README.md" }), /Path must be a Markdown file/);
});
