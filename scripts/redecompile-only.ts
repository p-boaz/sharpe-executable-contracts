import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readTextFile } from "../src/io/fs.js";
import { decompileExecutionToEnglish, type ExecutionEnglishRun } from "../src/core/decompiler.js";

const [, , contractKey] = process.argv;
if (!contractKey) {
  console.error("usage: tsx scripts/redecompile-only.ts <contract-key>");
  process.exit(1);
}

const base = resolve(process.cwd(), "out", "_web_runs", contractKey);

(async () => {
  const ir = JSON.parse(await readTextFile(resolve(base, "ir.json")));
  const scenarioFiles = (await readdir(resolve(base, "scenarios"))).filter((f) =>
    f.endsWith(".json"),
  );

  const runs: ExecutionEnglishRun[] = [];
  for (const file of scenarioFiles) {
    const archetype = file.replace(/\.json$/, "");
    const scenario = JSON.parse(await readTextFile(resolve(base, "scenarios", file)));
    const execution = JSON.parse(
      await readTextFile(resolve(base, "executions", file)),
    );
    runs.push({ archetype, scenario, execution });
  }

  const english = decompileExecutionToEnglish(ir, runs);
  process.stdout.write(english);
})();
