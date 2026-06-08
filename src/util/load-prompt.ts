import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src/util -> repo root is two dirs up.
const repoRoot = resolve(here, "..", "..");

const cache = new Map<string, string>();

export function loadPrompt(relativePath: string): string {
  const abs = resolve(repoRoot, relativePath);
  const cached = cache.get(abs);
  if (cached !== undefined) return cached;

  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(
      `loadPrompt: could not read ${relativePath} (resolved to ${abs}): ${String(err)}`,
    );
  }
  cache.set(abs, content);
  return content;
}
