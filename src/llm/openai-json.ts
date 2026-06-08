import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface OpenAIJsonCallOptions {
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

// Recorded-fixture mode. Keys fixtures by SHA-256 of the request payload
// (systemPrompt + userPrompt + model + reasoningEffort) so the lookup is
// stable across both in-process tests and child-process CLI invocations
// (`pnpm run run` spawned via execFileSync), and naturally invalidates
// when any of those inputs change — which is the behavior we want once
// prompts are settled.
//
// Modes, resolved from LLM_RECORD_MODE env var:
//   "replay"  — read from tests/fixtures/llm/<hash>.json (CI-safe; no key needed)
//   "record"  — hit the API, write the fixture, return the result
//   "live"    — hit the API, do not write (default when a key is present)
// When LLM_RECORD_MODE is unset:
//   - no key present  → "replay" (lets CI run the full suite)
//   - key present     → "live"
type RecorderMode = "replay" | "record" | "live";

function resolveRecorderMode(): RecorderMode {
  const explicit = process.env.LLM_RECORD_MODE;
  if (explicit === "replay" || explicit === "record" || explicit === "live") {
    return explicit;
  }
  return process.env.OPENAI_API_KEY ? "live" : "replay";
}

function fixtureDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/llm/openai-json.ts → repo root is two levels up
  return resolve(here, "..", "..", "tests", "fixtures", "llm");
}

function fixtureKey(options: OpenAIJsonCallOptions, model: string): string {
  const material = JSON.stringify({
    systemPrompt: options.systemPrompt,
    userPrompt: options.userPrompt,
    model,
    reasoningEffort: options.reasoningEffort ?? null,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

function readOutputText(payload: Record<string, unknown>): string {
  const outputText = payload.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const contentItem of content) {
        if (!contentItem || typeof contentItem !== "object") continue;
        const text = (contentItem as Record<string, unknown>).text;
        if (typeof text === "string" && text.trim()) {
          return text;
        }
      }
    }
  }

  throw new Error("OpenAI response did not include output text");
}

export async function callOpenAIJson<T>(options: OpenAIJsonCallOptions): Promise<T> {
  const mode = resolveRecorderMode();
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4";
  const key = fixtureKey(options, model);
  const fixturePath = resolve(fixtureDir(), `${key}.json`);

  if (mode === "replay") {
    if (!existsSync(fixturePath)) {
      throw new Error(
        `LLM replay: no fixture for key ${key} at ${fixturePath}.\n` +
          `Run with LLM_RECORD_MODE=record and OPENAI_API_KEY set to generate it.\n` +
          `This usually means the prompt, model, or user input changed — re-record on purpose.`,
      );
    }
    return JSON.parse(readFileSync(fixturePath, "utf8")) as T;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for LLM mode");
  }

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: options.systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: options.userPrompt }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "structured_output",
          schema: options.schema,
          strict: false,
        },
      },
      ...(options.reasoningEffort
        ? { reasoning: { effort: options.reasoningEffort } }
        : {}),
    }),
  });
  } catch (err) {
    // Surface the underlying cause (e.g. "Headers Timeout Error") which Node's
    // fetch otherwise hides behind an opaque "fetch failed" message.
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `fetch to OpenAI threw: ${err instanceof Error ? err.message : String(err)} | cause: ${causeMsg}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI request failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const outputText = readOutputText(payload);
  const parsed = JSON.parse(outputText) as T;

  if (mode === "record") {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  return parsed;
}
