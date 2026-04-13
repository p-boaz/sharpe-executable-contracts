import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const WEB_RUNS_DIR = path.resolve(process.cwd(), "..", "out", "_web_runs");
const REPO_ROOT = path.resolve(process.cwd(), "..");
const execFileAsync = promisify(execFile);

interface ExecuteRequest {
  contractKey?: string;
  contractId?: string;
  archetype?: string;
}

function isSafeSegment(value: string): boolean {
  return /^[a-z0-9._-]+$/i.test(value);
}

const EXECUTE_SCRIPT = [
  'import { readFile } from "node:fs/promises";',
  'import { executeContract } from "./src/core/executor.ts";',
  'import { decompileRuns } from "./src/pipeline/run-pipeline.ts";',
  'import { hashText } from "./src/pipeline/meta.ts";',
  "(async () => {",
  "  const [irPath, scenarioPath] = process.argv.slice(-2);",
  "  if (!irPath || !scenarioPath) throw new Error('Missing ir/scenario path');",
  "  const [irRaw, scenarioRaw] = await Promise.all([",
  '    readFile(irPath, "utf8"),',
  '    readFile(scenarioPath, "utf8"),',
  "  ]);",
  "  const ir = JSON.parse(irRaw);",
  "  const scenario = JSON.parse(scenarioRaw);",
  "  const execution = executeContract(ir, scenario);",
  "  const archetype = scenario.archetype || scenario.scenarioId || 'selected';",
  "  const english = decompileRuns(ir, [{ archetype, scenario, execution }]);",
  "  const englishHash = hashText(english);",
  "  process.stdout.write(JSON.stringify({ execution, english, englishHash }));",
  "})();",
].join("\n");

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: ExecuteRequest;
  try {
    body = (await request.json()) as ExecuteRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const contractKey = body.contractKey?.trim() ?? body.contractId?.trim();
  const archetype = body.archetype?.trim();

  if (!contractKey || !archetype) {
    return NextResponse.json(
      { error: "contractKey and archetype are required" },
      { status: 400 },
    );
  }
  if (!isSafeSegment(contractKey) || !isSafeSegment(archetype)) {
    return NextResponse.json(
      { error: "Invalid contractKey or archetype" },
      { status: 400 },
    );
  }

  try {
    const base = path.join(WEB_RUNS_DIR, contractKey);
    const irPath = path.join(base, "ir.json");
    const scenarioPath = path.join(base, "scenarios", `${archetype}.json`);
    const executionPath = path.join(base, "executions", `${archetype}.json`);
    const englishPath = path.join(base, "english.txt");
    const metaPath = path.join(base, "meta.json");

    await Promise.all([fs.access(irPath), fs.access(scenarioPath)]);

    const { stdout, stderr } = await execFileAsync(
      "pnpm",
      ["exec", "tsx", "--eval", EXECUTE_SCRIPT, irPath, scenarioPath],
      {
        cwd: REPO_ROOT,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (stderr && stderr.trim()) {
      throw new Error(stderr.trim());
    }
    const payload = JSON.parse(stdout) as {
      execution?: unknown;
      english?: string;
      englishHash?: string;
    };
    if (!payload.execution || typeof payload.english !== "string" || !payload.englishHash) {
      throw new Error("Execution completed but response could not be parsed");
    }
    const execution = payload.execution as any;

    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(path.dirname(executionPath), { recursive: true });
    await Promise.all([
      fs.writeFile(executionPath, `${JSON.stringify(execution, null, 2)}\n`, "utf8"),
      fs.writeFile(englishPath, payload.english, "utf8"),
    ]);

    try {
      const executedAt = new Date().toISOString();
      const raw = await fs.readFile(metaPath, "utf8");
      const meta = JSON.parse(raw) as {
        englishHash?: string;
        scenarios?: Array<{
          archetype?: string;
          endingBalance?: number;
          breached?: boolean;
          breachCount?: number;
        }>;
        stages?: Record<string, string>;
      };
      if (Array.isArray(meta.scenarios)) {
        meta.scenarios = meta.scenarios.map((entry) => {
          if (entry.archetype !== archetype) return entry;
          return {
            ...entry,
            endingBalance: execution?.summary?.endingBalance,
            breached: execution?.summary?.breached,
            breachCount: Array.isArray(execution?.breaches) ? execution.breaches.length : 0,
          };
        });
      }
      meta.stages = {
        ...(meta.stages ?? {}),
        lastExecutedAt: executedAt,
        englishGeneratedAt: executedAt,
      };
      meta.englishHash = payload.englishHash;
      await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    } catch {
      // meta.json is optional for execution API
    }

    return NextResponse.json({ execution });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Could not execute contract '${contractKey}' for scenario '${archetype}'`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
