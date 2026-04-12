import fs from "node:fs/promises";
import path from "node:path";
import Dossier from "./Dossier";
import type { ContractMeta, IR, RunResult, Scenario } from "./lib/types";

const OUT_DIR = path.resolve(process.cwd(), "..", "out");

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

async function listContracts(): Promise<ContractMeta[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(OUT_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas: ContractMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("_")) continue;
    const meta = await readJson<ContractMeta>(path.join(OUT_DIR, e.name, "meta.json"));
    if (meta && Array.isArray(meta.scenarios)) metas.push(meta);
  }
  return metas.sort((a, b) => a.contractId.localeCompare(b.contractId));
}

async function loadContract(contractId: string, archetype: string | null) {
  const base = path.join(OUT_DIR, contractId);
  const [ir, contract, english, meta] = await Promise.all([
    readJson<IR>(path.join(base, "ir.json")),
    readText(path.join(base, "contract.md")),
    readText(path.join(base, "english.txt")),
    readJson<ContractMeta>(path.join(base, "meta.json")),
  ]);

  const archetypes = (meta?.scenarios ?? []).map((s) => s.archetype);
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

  return { ir, contract, english, meta, scenario, execution, selectedArchetype };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ contract?: string; scenario?: string; run?: string }>;
}) {
  const params = await searchParams;
  const contracts = await listContracts();

  if (contracts.length === 0) {
    return (
      <main className="sheet">
        <div className="err">
          <h3>No contracts found.</h3>
          <p>
            Expected <code>../out/&lt;contractId&gt;/meta.json</code>. Run the pipeline:
          </p>
          <p>
            <code>pnpm demo</code> &nbsp;or&nbsp;{" "}
            <code>pnpm run run --contract contracts/&lt;file&gt;.md</code>
          </p>
        </div>
      </main>
    );
  }

  const requested = params.contract ?? params.run;
  const selectedContractId =
    requested && contracts.some((c) => c.contractId === requested)
      ? requested
      : contracts[0].contractId;

  const loaded = await loadContract(selectedContractId, params.scenario ?? null);

  if (!loaded.ir || !loaded.meta) {
    return (
      <main className="sheet">
        <div className="err">
          <h3>
            Contract <code>{selectedContractId}</code> is missing artifacts.
          </h3>
        </div>
      </main>
    );
  }

  return (
    <Dossier
      contracts={contracts}
      selectedContractId={selectedContractId}
      meta={loaded.meta}
      ir={loaded.ir}
      contract={loaded.contract}
      english={loaded.english}
      scenario={loaded.scenario}
      execution={loaded.execution}
      selectedArchetype={loaded.selectedArchetype}
    />
  );
}
