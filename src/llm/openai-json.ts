interface OpenAIJsonCallOptions {
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  model?: string;
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for LLM mode");
  }

  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const response = await fetch("https://api.openai.com/v1/responses", {
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
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI request failed: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const outputText = readOutputText(payload);
  return JSON.parse(outputText) as T;
}
