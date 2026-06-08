import { strict as assert } from "node:assert";
import test from "node:test";
import { loadPrompt } from "../src/util/load-prompt.js";

test("loadPrompt reads a prompt file relative to the repo root", () => {
  const content = loadPrompt("prompts/ir-extraction.md");
  assert.ok(content.length > 200, `expected length > 200, got ${content.length}`);
  assert.match(content, /effect\.kind/);
});

test("loadPrompt throws a clear error when the prompt is missing", () => {
  assert.throws(
    () => loadPrompt("prompts/does-not-exist.md"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("prompts/does-not-exist.md"),
        `expected path in error message, got: ${err.message}`,
      );
      return true;
    },
  );
});

test("loadPrompt caches reads per process", () => {
  const first = loadPrompt("prompts/ir-extraction.md");
  const second = loadPrompt("prompts/ir-extraction.md");
  assert.ok(first === second, "expected same string instance (cache identity)");
});
