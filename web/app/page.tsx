import fs from "node:fs/promises";
import path from "node:path";
import Dossier from "./Dossier";
import type { IR, Scenario, RunResult } from "./lib/types";

const OUT_DIR = path.resolve(process.cwd(), "..", "out");

export interface RunSummary {
  run: string;
  title: string;
  eventCount: number;
  firstEvents: { date?: string; type: string }[];
  endingBalance?: number;
  breached?: boolean;
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, "utf8")) as T; }
  catch { return null; }
}
async function readText(p: string): Promise<string> {
  try { return await fs.readFile(p, "utf8"); }
  catch { return ""; }
}

async function listRuns(): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(OUT_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await fs.access(path.join(OUT_DIR, e.name, "ir.json"));
      dirs.push(e.name);
    } catch {
      // skip runs without an IR artifact (e.g. determinism/)
    }
  }
  return dirs.sort((a, b) => {
    if (a === "run") return -1;
    if (b === "run") return 1;
    return a.localeCompare(b);
  });
}

async function loadSummary(run: string): Promise<RunSummary> {
  const base = path.join(OUT_DIR, run);
  const [ir, scenario, runResult] = await Promise.all([
    readJson<IR>(path.join(base, "ir.json")),
    readJson<Scenario>(path.join(base, "scenario.json")),
    readJson<RunResult>(path.join(base, "execution.json")),
  ]);
  const events = scenario?.events ?? [];
  return {
    run,
    title: ir?.title ?? run,
    eventCount: events.length,
    firstEvents: events.slice(0, 3).map(e => ({ date: e.date, type: e.type })),
    endingBalance: runResult?.summary?.endingBalance,
    breached: runResult?.summary?.breached,
  };
}

async function loadRun(run: string) {
  const base = path.join(OUT_DIR, run);
  const [ir, scenario, runResult, english, contract] = await Promise.all([
    readJson<IR>(path.join(base, "ir.json")),
    readJson<Scenario>(path.join(base, "scenario.json")),
    readJson<RunResult>(path.join(base, "execution.json")),
    readText(path.join(base, "english.txt")),
    readText(path.join(base, "contract.md")),
  ]);
  return { ir, scenario, runResult, english, contract };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run: runParam } = await searchParams;
  const runs = await listRuns();

  if (runs.length === 0) {
    return (
      <main className="sheet">
        <div className="err">
          <h3>No runs found.</h3>
          <p>
            Expected artifact directories at <code>../out/&lt;run&gt;/</code> containing{" "}
            <code>ir.json</code>. Run the pipeline first:
          </p>
          <p><code>pnpm demo</code> &nbsp;or&nbsp; <code>pnpm run</code></p>
        </div>
      </main>
    );
  }

  const selected = runParam && runs.includes(runParam) ? runParam : runs[0];
  const [data, summaries] = await Promise.all([
    loadRun(selected),
    Promise.all(runs.map(loadSummary)),
  ]);

  if (!data.ir) {
    return (
      <main className="sheet">
        <div className="err">
          <h3>Run <code>{selected}</code> has no <code>ir.json</code>.</h3>
        </div>
      </main>
    );
  }

  return (
    <Dossier
      summaries={summaries}
      selected={selected}
      ir={data.ir}
      scenario={data.scenario}
      runResult={data.runResult}
      english={data.english}
      contract={data.contract}
    />
  );
}
