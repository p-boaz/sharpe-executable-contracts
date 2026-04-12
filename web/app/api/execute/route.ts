import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const OUT_DIR = path.resolve(process.cwd(), "..", "out");
const REPO_ROOT = path.resolve(process.cwd(), "..");
const execFileAsync = promisify(execFile);

interface ExecuteRequest {
  contractId?: string;
  archetype?: string;
}

function isSafeSegment(value: string): boolean {
  return /^[a-z0-9._-]+$/i.test(value);
}

const EXECUTE_SCRIPT = [
  'import { readFile } from "node:fs/promises";',
  'import { executeContract } from "./src/core/executor.ts";',
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
  "  process.stdout.write(JSON.stringify(execution));",
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

  const contractId = body.contractId?.trim();
  const archetype = body.archetype?.trim();

  if (!contractId || !archetype) {
    return NextResponse.json(
      { error: "contractId and archetype are required" },
      { status: 400 },
    );
  }
  if (!isSafeSegment(contractId) || !isSafeSegment(archetype)) {
    return NextResponse.json(
      { error: "Invalid contractId or archetype" },
      { status: 400 },
    );
  }

  try {
    const base = path.join(OUT_DIR, contractId);
    const irPath = path.join(base, "ir.json");
    const scenarioPath = path.join(base, "scenarios", `${archetype}.json`);

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
    const execution = JSON.parse(stdout);
    return NextResponse.json({ execution });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Could not execute contract '${contractId}' for scenario '${archetype}'`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
