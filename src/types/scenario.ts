export type ScenarioEventType =
  | "purchase"
  | "cash_advance"
  | "payment"
  | "statement_close"
  | "due_check"
  | "notice"
  | "delivery"
  | "action";

// Generic executor (T22) reads optional hints from `metadata`:
//   metadata.clauseId — explicit bind to an obligation (hybrid-match preferred branch)
//   metadata.actor    — used by the actor+verb+window fallback when clauseId is absent
export interface ScenarioEvent {
  id: string;
  date: string;
  type: ScenarioEventType;
  amount?: number;
  metadata?: Record<string, unknown>;
}

export interface Scenario {
  scenarioId: string;
  archetype?: string;
  label?: string;
  assumptions: string[];
  initialState: Record<string, unknown>;
  events: ScenarioEvent[];
  metadata?: {
    generation: {
      llmRequested: boolean;
      llmUsed: boolean;
      mode: "llm";
      archetype?: string;
      contractHash?: string;
      contractChars?: number;
      promptTruncated?: boolean;
      validationNote?: string;
    };
  };
}
