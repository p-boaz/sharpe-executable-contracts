export type ScenarioEventType =
  | "purchase"
  | "cash_advance"
  | "payment"
  | "statement_close"
  | "due_check"
  | "notice";

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
      mode: "llm" | "deterministic_fallback" | "llm_validated_fallback";
      archetype?: string;
      validationNote?: string;
    };
  };
}
