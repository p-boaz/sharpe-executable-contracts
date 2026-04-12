import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stableStringify } from "../util/json.js";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${stableStringify(value)}\n`);
}
