import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const REPO_ROOT = path.resolve(process.cwd(), "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const UPLOADED_DIR = path.join(CONTRACTS_DIR, "_uploaded");
const WEB_RUNS_DIR = path.join(REPO_ROOT, "out", "_web_runs");
const execFileAsync = promisify(execFile);

interface RunContractRequest {
  action?: string;
  contractKey?: string;
  contractId?: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function listContractFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));
}

async function resolveContractMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const bundled = (await listContractFiles(CONTRACTS_DIR)).filter(
    (sourceFile) => sourceFile !== "SOURCES.md",
  );
  for (const sourceFile of bundled) {
    map.set(slugify(sourceFile), sourceFile);
  }
  const uploaded = await listContractFiles(UPLOADED_DIR);
  for (const sourceFile of uploaded) {
    map.set(slugify(sourceFile), path.posix.join("_uploaded", sourceFile));
  }
  return map;
}

function isSafeSegment(value: string): boolean {
  return /^[a-z0-9._-]+$/i.test(value);
}

function parseJsonOutput<T>(stdout: string, fallbackError: string): T {
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error(fallbackError);
  }
}

const GENERATE_IR_SCRIPT = [
  'import { createHash } from "node:crypto";',
  'import { resolve } from "node:path";',
  'import { ensureDir, readTextFile, writeJson, writeText } from "./src/io/fs.ts";',
  'import { extractIr } from "./src/pipeline/extract-ir.ts";',
  'import { stableStringify } from "./src/util/json.ts";',
  "",
  "const hash = (value) => createHash('sha256').update(value).digest('hex');",
  "",
  "(async () => {",
  "  const [contractPath, outDir, sourceFile, contractKey, useLlmRaw] = process.argv.slice(-5);",
  "  const useLlm = useLlmRaw === 'true';",
  "  const contractText = await readTextFile(contractPath);",
  "  const ir = await extractIr({ contractText, contractPath, useLlm });",
  "  const generatedAt = new Date().toISOString();",
  "  const meta = {",
  "    contractId: contractKey,",
  "    title: ir.title,",
  "    family: 'unknown',",
  "    sourceFile,",
  "    irHash: hash(stableStringify(ir)),",
  "    stages: { irGeneratedAt: generatedAt },",
  "    scenarios: [],",
  "  };",
  "  await ensureDir(outDir);",
  "  await writeText(resolve(outDir, 'contract.md'), contractText);",
  "  await writeJson(resolve(outDir, 'ir.json'), ir);",
  "  await writeJson(resolve(outDir, 'meta.json'), meta);",
  "  process.stdout.write(JSON.stringify({ meta }));",
  "})();",
].join("\n");

const GENERATE_SCENARIOS_SCRIPT = [
  'import { rm } from "node:fs/promises";',
  'import { resolve } from "node:path";',
  'import { ensureDir, readTextFile, writeJson } from "./src/io/fs.ts";',
  'import { generateAllScenarios } from "./src/pipeline/generate-scenario.ts";',
  "",
  "(async () => {",
  "  const [contractPath, outDir, sourceFile, contractKey, useLlmRaw] = process.argv.slice(-5);",
  "  const useLlm = useLlmRaw === 'true';",
  "  const [contractText, irRaw] = await Promise.all([",
  "    readTextFile(contractPath),",
  "    readTextFile(resolve(outDir, 'ir.json')),",
  "  ]);",
  "  const ir = JSON.parse(irRaw);",
  "  const { family, scenarios } = await generateAllScenarios({ ir, contractText, useLlm });",
  "",
  "  let existingMeta = {};",
  "  try {",
  "    existingMeta = JSON.parse(await readTextFile(resolve(outDir, 'meta.json')));",
  "  } catch {}",
  "",
  "  await rm(resolve(outDir, 'scenarios'), { recursive: true, force: true });",
  "  await rm(resolve(outDir, 'executions'), { recursive: true, force: true });",
  "  await rm(resolve(outDir, 'english.txt'), { force: true });",
  "  await ensureDir(resolve(outDir, 'scenarios'));",
  "",
  "  for (const scenario of scenarios) {",
  "    const archetype = scenario.archetype || scenario.scenarioId;",
  "    await writeJson(resolve(outDir, 'scenarios', `${archetype}.json`), scenario);",
  "  }",
  "",
  "  const generatedAt = new Date().toISOString();",
  "  const { englishHash: _oldEnglishHash, stages: oldStages = {}, ...metaRest } = existingMeta;",
  "  const { englishGeneratedAt: _oldEnglishGeneratedAt, lastExecutedAt: _oldLastExecutedAt, ...stageRest } = oldStages;",
  "  const meta = {",
  "    ...metaRest,",
  "    contractId: contractKey,",
  "    title: ir.title || existingMeta.title || contractKey,",
  "    family,",
  "    sourceFile,",
  "    stages: {",
  "      ...stageRest,",
  "      scenariosGeneratedAt: generatedAt,",
  "    },",
  "    scenarios: scenarios.map((scenario) => ({",
  "      archetype: scenario.archetype || scenario.scenarioId,",
  "      label: scenario.label || scenario.scenarioId,",
  "      scenarioId: scenario.scenarioId,",
  "    })),",
  "  };",
  "",
  "  await writeJson(resolve(outDir, 'meta.json'), meta);",
  "  process.stdout.write(JSON.stringify({ meta }));",
  "})();",
].join("\n");

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: RunContractRequest;
  try {
    body = (await request.json()) as RunContractRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action?.trim();
  const contractKey = body.contractKey?.trim() ?? body.contractId?.trim();

  if (!action || !["generate-ir", "generate-scenarios"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  if (!contractKey) {
    return NextResponse.json(
      { error: "contractKey is required" },
      { status: 400 },
    );
  }
  if (!isSafeSegment(contractKey)) {
    return NextResponse.json({ error: "Invalid contractKey" }, { status: 400 });
  }

  try {
    const contracts = await resolveContractMap();
    const sourceFile = contracts.get(contractKey);
    if (!sourceFile) {
      return NextResponse.json(
        { error: "Unknown contractKey" },
        { status: 404 },
      );
    }

    const useLlm = true;
    const contractPath = path.join(CONTRACTS_DIR, sourceFile);
    const outDir = path.join(WEB_RUNS_DIR, contractKey);

    if (action === "generate-ir") {
      await fs.rm(outDir, { recursive: true, force: true });

      const { stdout } = await execFileAsync(
        "pnpm",
        [
          "exec",
          "tsx",
          "--eval",
          GENERATE_IR_SCRIPT,
          contractPath,
          outDir,
          sourceFile,
          contractKey,
          String(useLlm),
        ],
        { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024 },
      );

      const payload = parseJsonOutput<{ meta: unknown }>(
        stdout,
        "IR generation completed but response could not be parsed",
      );
      return NextResponse.json({
        ok: true,
        action,
        contractKey,
        sourceFile,
        meta: payload.meta,
      });
    }

    try {
      await fs.access(path.join(outDir, "ir.json"));
    } catch {
      return NextResponse.json(
        { error: "IR artifacts not found. Generate IR first." },
        { status: 400 },
      );
    }

    const { stdout } = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "--eval",
        GENERATE_SCENARIOS_SCRIPT,
        contractPath,
        outDir,
        sourceFile,
        contractKey,
        String(useLlm),
      ],
      { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024 },
    );

    const payload = parseJsonOutput<{ meta: unknown }>(
      stdout,
      "Scenario generation completed but response could not be parsed",
    );
    return NextResponse.json({
      ok: true,
      action,
      contractKey,
      sourceFile,
      meta: payload.meta,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : action === "generate-ir"
          ? "IR generation failed"
          : "Scenario generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
