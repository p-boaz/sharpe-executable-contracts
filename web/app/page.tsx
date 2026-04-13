import fs from "node:fs/promises";
import path from "node:path";
import Dossier from "./Dossier";
import { PRELOADED_FIXTURES } from "./lib/preloaded";
import type { ContractMeta, ContractOption, IR, RunResult, Scenario } from "./lib/types";

const CONTRACTS_DIR = path.resolve(process.cwd(), "..", "contracts");
const UPLOADED_DIR = path.resolve(CONTRACTS_DIR, "_uploaded");
const OUT_DIR = path.resolve(process.cwd(), "..", "out");
const WEB_RUNS_DIR = path.resolve(OUT_DIR, "_web_runs");

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readText(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

async function listContracts(): Promise<ContractOption[]> {
  const bundled = (await listMarkdownFiles(CONTRACTS_DIR))
    .filter((sourceFile) => sourceFile !== "SOURCES.md")
    .map((sourceFile): Omit<ContractOption, "processed" | "irReady" | "scenariosReady" | "hasPreloaded"> => ({
      key: slugify(sourceFile),
      sourceFile,
      title: titleFromFileName(sourceFile),
      origin: "bundled",
    }));
  const uploaded = (await listMarkdownFiles(UPLOADED_DIR)).map(
    (sourceFile): Omit<ContractOption, "processed" | "irReady" | "scenariosReady" | "hasPreloaded"> => ({
      key: slugify(sourceFile),
      sourceFile: path.posix.join("_uploaded", sourceFile),
      title: `${titleFromFileName(sourceFile)} (uploaded)`,
      origin: "uploaded",
    }),
  );
  const contracts = [...bundled, ...uploaded];

  const options: ContractOption[] = [];
  for (const contract of contracts) {
    const fixtureDirName = PRELOADED_FIXTURES[contract.key];
    const [meta, ir, hasPreloaded] = await Promise.all([
      readJson<ContractMeta>(path.join(WEB_RUNS_DIR, contract.key, "meta.json")),
      readJson<IR>(path.join(WEB_RUNS_DIR, contract.key, "ir.json")),
      fixtureDirName
        ? fileExists(path.join(OUT_DIR, fixtureDirName, "meta.json"))
        : Promise.resolve(false),
    ]);
    const scenariosReady = Boolean(meta && Array.isArray(meta.scenarios) && meta.scenarios.length > 0);
    options.push({
      ...contract,
      processed: scenariosReady,
      irReady: Boolean(ir),
      scenariosReady,
      hasPreloaded,
    });
  }
  return options;
}

async function loadContract(contract: ContractOption, archetype: string | null): Promise<{
  contractText: string;
  ir: IR | null;
  english: string;
  meta: ContractMeta | null;
  scenario: Scenario | null;
  execution: RunResult | null;
  selectedArchetype: string | null;
}> {
  const base = path.join(WEB_RUNS_DIR, contract.key);
  const [contractText, ir, english, meta] = await Promise.all([
    readText(path.join(CONTRACTS_DIR, contract.sourceFile)),
    readJson<IR>(path.join(base, "ir.json")),
    readText(path.join(base, "english.txt")),
    readJson<ContractMeta>(path.join(base, "meta.json")),
  ]);

  const metaWithKey = meta ? { ...meta, contractId: contract.key } : null;
  const archetypes = (metaWithKey?.scenarios ?? []).map((s) => s.archetype);
  const selectedArchetype =
    archetype && archetypes.includes(archetype) ? archetype : archetypes[0] ?? null;

  let scenario: Scenario | null = null;
  let execution: RunResult | null = null;
  if (selectedArchetype) {
    [scenario, execution] = await Promise.all([
      readJson<Scenario>(path.join(base, "scenarios", `${selectedArchetype}.json`)),
      readJson<RunResult>(path.join(base, "executions", `${selectedArchetype}.json`)),
    ]);
  }

  return { contractText, ir, english, meta: metaWithKey, scenario, execution, selectedArchetype };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ contract?: string; scenario?: string }>;
}) {
  const params = await searchParams;
  const contracts = await listContracts();

  if (contracts.length === 0) {
    return (
      <main className="sheet">
        <div className="err">
          <h3>No contracts found.</h3>
          <p>
            Expected markdown files under <code>../contracts/</code> or uploaded
            files under <code>../contracts/_uploaded/</code>.
          </p>
        </div>
      </main>
    );
  }

  const selectedContract =
    contracts.find((contract) => contract.key === params.contract) ?? contracts[0];
  const loaded = await loadContract(selectedContract, params.scenario ?? null);

  return (
    <Dossier
      contracts={contracts}
      selectedContractKey={selectedContract.key}
      selectedSourceFile={selectedContract.sourceFile}
      meta={loaded.meta}
      ir={loaded.ir}
      contract={loaded.contractText}
      english={loaded.english}
      scenario={loaded.scenario}
      execution={loaded.execution}
      selectedArchetype={loaded.selectedArchetype}
    />
  );
}
