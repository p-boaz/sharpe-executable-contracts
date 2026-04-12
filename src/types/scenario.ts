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
  metadata?: Record<string, string | number | boolean>;
}

export interface Scenario {
  scenarioId: string;
  assumptions: string[];
  initialState: Record<string, string | number | boolean>;
  events: ScenarioEvent[];
}
