import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "out";
const OUT_ROOT = join(process.cwd(), OUT);

interface Row {
  contract: string;
  clauses: number;
  modeled: number;
  unmodeled: number;
  definitions: number;
  archetypes: number;
  obligations: number;
  ledgerEvents: number;
}

function tally(dir: string): Row | null {
  const irPath = join(OUT_ROOT, dir, "ir.json");
  const metaPath = join(OUT_ROOT, dir, "meta.json");
  const execDir = join(OUT_ROOT, dir, "executions");
  if (!existsSync(irPath)) return null;
  const ir = JSON.parse(readFileSync(irPath, "utf8"));
  const clauses = Array.isArray(ir.clauses) ? ir.clauses : [];
  const modeled = clauses.filter(
    (c: any) => c?.modeled === true || (c?.modeled !== false && c?.effect),
  ).length;
  const unmodeled = clauses.length - modeled;
  const definitions = Array.isArray(ir.definitions) ? ir.definitions.length : 0;

  const meta = existsSync(metaPath)
    ? JSON.parse(readFileSync(metaPath, "utf8"))
    : {};
  const archetypes = Array.isArray(meta.scenarios)
    ? new Set(meta.scenarios.map((s: any) => s.archetype)).size
    : 0;

  let obligations = 0;
  let ledgerEvents = 0;
  if (existsSync(execDir)) {
    for (const f of readdirSync(execDir)) {
      if (!f.endsWith(".json")) continue;
      const exec = JSON.parse(readFileSync(join(execDir, f), "utf8"));
      const obs = Array.isArray(exec.obligations) ? exec.obligations : [];
      obligations += obs.length;
      const ledger = Array.isArray(exec.ledger) ? exec.ledger : [];
      ledgerEvents += ledger.length;
    }
  }
  return {
    contract: dir,
    clauses: clauses.length,
    modeled,
    unmodeled,
    definitions,
    archetypes,
    obligations,
    ledgerEvents,
  };
}

const rows: Row[] = [];
for (const dir of readdirSync(OUT_ROOT).sort()) {
  const r = tally(dir);
  if (r) rows.push(r);
}

const header = [
  "CONTRACT",
  "CLAUSES",
  "MODELED",
  "UNMODELED",
  "DEFS",
  "ARCHETYPES",
  "OBLIG",
  "LEDGER",
];
const widths = [42, 8, 8, 10, 6, 11, 6, 7];
const fmt = (cells: (string | number)[]) =>
  cells.map((c, i) => String(c).padEnd(widths[i])).join("");
console.log(fmt(header));
console.log("-".repeat(widths.reduce((a, b) => a + b, 0)));
let total = {
  clauses: 0,
  modeled: 0,
  unmodeled: 0,
  defs: 0,
  arche: 0,
  ob: 0,
  led: 0,
};
for (const r of rows) {
  console.log(
    fmt([
      r.contract.slice(0, 40),
      r.clauses,
      r.modeled,
      r.unmodeled,
      r.definitions,
      r.archetypes,
      r.obligations,
      r.ledgerEvents,
    ]),
  );
  total.clauses += r.clauses;
  total.modeled += r.modeled;
  total.unmodeled += r.unmodeled;
  total.defs += r.definitions;
  total.arche += r.archetypes;
  total.ob += r.obligations;
  total.led += r.ledgerEvents;
}
console.log("-".repeat(widths.reduce((a, b) => a + b, 0)));
console.log(
  fmt([
    `TOTAL (${rows.length})`,
    total.clauses,
    total.modeled,
    total.unmodeled,
    total.defs,
    total.arche,
    total.ob,
    total.led,
  ]),
);
