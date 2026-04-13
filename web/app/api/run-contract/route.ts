import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDir,
  readTextFile,
  writeJson,
  writeText,
} from "../../../../src/io/fs.js";
import {
  extractContract,
  generateRuns,
} from "../../../../src/pipeline/run-pipeline.js";
import { buildMeta } from "../../../../src/pipeline/meta.js";
import { PRELOADED_FIXTURES } from "../../lib/preloaded";

const REPO_ROOT = path.resolve(process.cwd(), "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const UPLOADED_DIR = path.join(CONTRACTS_DIR, "_uploaded");
const OUT_DIR = path.join(REPO_ROOT, "out");
const WEB_RUNS_DIR = path.join(OUT_DIR, "_web_runs");

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

async function runGenerateIr(
  contractPath: string,
  outDir: string,
  contractKey: string,
): Promise<unknown> {
  const { contractText, ir } = await extractContract({ contractPath });
  const meta = buildMeta({
    contractId: contractKey,
    ir,
    stageTimestamp: {
      key: "irGeneratedAt",
      value: new Date().toISOString(),
    },
  });
  await ensureDir(outDir);
  await writeText(path.resolve(outDir, "contract.md"), contractText);
  await writeJson(path.resolve(outDir, "ir.json"), ir);
  await writeJson(path.resolve(outDir, "meta.json"), meta);
  return meta;
}

async function runGenerateScenarios(
  contractPath: string,
  outDir: string,
  contractKey: string,
): Promise<unknown> {
  const [contractText, irRaw] = await Promise.all([
    readTextFile(contractPath),
    readTextFile(path.resolve(outDir, "ir.json")),
  ]);
  const ir = JSON.parse(irRaw);
  const { family, runs } = await generateRuns({ ir, contractText });

  let existingMeta: Record<string, unknown> = {};
  try {
    existingMeta = JSON.parse(
      await readTextFile(path.resolve(outDir, "meta.json")),
    );
  } catch {
    // first run has no prior meta; treat as empty
  }

  await fs.rm(path.resolve(outDir, "scenarios"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.resolve(outDir, "executions"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.resolve(outDir, "english.txt"), { force: true });
  await ensureDir(path.resolve(outDir, "scenarios"));
  await ensureDir(path.resolve(outDir, "executions"));

  await Promise.all(
    runs.flatMap((run) => [
      writeJson(
        path.resolve(outDir, "scenarios", `${run.archetype}.json`),
        run.scenario,
      ),
      writeJson(
        path.resolve(outDir, "executions", `${run.archetype}.json`),
        run.execution,
      ),
    ]),
  );

  const meta = buildMeta({
    contractId: contractKey,
    ir,
    family,
    runs,
    existingMeta,
    stageTimestamp: {
      key: "scenariosGeneratedAt",
      value: new Date().toISOString(),
    },
  });
  await writeJson(path.resolve(outDir, "meta.json"), meta);
  return meta;
}

async function runLoadPreloaded(
  outDir: string,
  contractKey: string,
): Promise<unknown> {
  const fixtureDirName = PRELOADED_FIXTURES[contractKey];
  if (!fixtureDirName) {
    throw new Error("No preloaded bundle is available for this contract");
  }
  const fixtureDir = path.join(OUT_DIR, fixtureDirName);
  try {
    await fs.access(path.join(fixtureDir, "meta.json"));
  } catch {
    throw new Error(
      `Preloaded bundle missing at out/${fixtureDirName}/meta.json`,
    );
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await ensureDir(outDir);
  await fs.cp(fixtureDir, outDir, { recursive: true });

  // The bundle was generated under its own contractId; rewrite to the web
  // runs key so the UI stays consistent when it reads meta.json directly.
  const metaPath = path.resolve(outDir, "meta.json");
  try {
    const raw = JSON.parse(await readTextFile(metaPath)) as Record<string, unknown>;
    raw.contractId = contractKey;
    await writeJson(metaPath, raw);
    return raw;
  } catch {
    return null;
  }
}

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

  if (
    !action ||
    !["generate-ir", "generate-scenarios", "load-preloaded"].includes(action)
  ) {
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

    const contractPath = path.join(CONTRACTS_DIR, sourceFile);
    const outDir = path.join(WEB_RUNS_DIR, contractKey);

    if (action === "generate-ir") {
      await fs.rm(outDir, { recursive: true, force: true });
      const meta = await runGenerateIr(contractPath, outDir, contractKey);
      return NextResponse.json({
        ok: true,
        action,
        contractKey,
        sourceFile,
        meta,
      });
    }

    if (action === "load-preloaded") {
      const meta = await runLoadPreloaded(outDir, contractKey);
      return NextResponse.json({
        ok: true,
        action,
        contractKey,
        sourceFile,
        meta,
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

    const meta = await runGenerateScenarios(contractPath, outDir, contractKey);
    return NextResponse.json({
      ok: true,
      action,
      contractKey,
      sourceFile,
      meta,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : action === "generate-ir"
          ? "IR generation failed"
          : action === "load-preloaded"
            ? "Loading preloaded bundle failed"
            : "Scenario generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
