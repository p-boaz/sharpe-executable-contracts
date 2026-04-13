"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type {
  Breach,
  Clause,
  ContractOption,
  ContractMeta,
  Expr,
  IR,
  LedgerEntry,
  Obligation,
  RunResult,
  Scenario,
} from "./lib/types";

interface Props {
  contracts: ContractOption[];
  selectedContractKey: string;
  selectedSourceFile: string;
  meta: ContractMeta | null;
  ir: IR | null;
  contract: string;
  english: string;
  scenario: Scenario | null;
  execution: RunResult | null;
  selectedArchetype: string | null;
}

type Link = { clauseId?: string; eventId?: string };

function fmtMoney(n: number | undefined | null, currency = "USD"): string {
  if (n == null || Number.isNaN(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return "$" + Number(n).toFixed(2);
  }
}

function fmtDate(d?: string): string {
  if (!d) return "";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function fmtNumber(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}

function fmtScenarioValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderExpr(e: Expr | undefined): string {
  if (!e) return "";
  if (e.op === "const") return String(e.value);
  if (e.op === "var") return String(e.name);
  const a = (i: number) => renderExpr(e.args?.[i]);
  if (e.op === "mul") return `(${a(0)} × ${a(1)})`;
  if (e.op === "add") return `(${a(0)} + ${a(1)})`;
  if (e.op === "sub") return `(${a(0)} − ${a(1)})`;
  if (e.op === "div") return `(${a(0)} ÷ ${a(1)})`;
  if (e.op === "max") return `max(${e.args?.map(renderExpr).join(", ")})`;
  if (e.op === "min") return `min(${e.args?.map(renderExpr).join(", ")})`;
  return JSON.stringify(e);
}

function ClauseBody({ c }: { c: Clause }) {
  const effect = c.effect;
  if (!effect) return <div className="muted italic">{c.title ?? ""}</div>;

  const tagLabel = c.semanticTag ? (
    <span className="mono" style={{ opacity: 0.7 }}>
      {c.semanticTag}
    </span>
  ) : null;

  if (effect.kind === "formula" && effect.outputVar) {
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        computes <span className="mono">{effect.outputVar}</span>
        {" = "}
        <span className="mono">{renderExpr(effect.expr)}</span>
      </div>
    );
  }
  if (effect.kind === "payment") {
    const amountText = effect.amount?.op === "const" ? fmtMoney(Number(effect.amount.value)) : renderExpr(effect.amount);
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        {effect.payer ?? "party"} pays {effect.payee ?? "counterparty"}{" "}
        <span className="mono">{amountText}</span>
        {effect.assetKind ? <> [{effect.assetKind}]</> : null}
      </div>
    );
  }
  if (effect.kind === "obligation") {
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        {effect.actor ?? "party"} must {effect.action ?? "perform duty"}
        {effect.due?.value ? (
          <>
            {" "}
            ({effect.due?.type ?? "due"}: <span className="mono">{effect.due.value}</span>
            {effect.due?.direction ? ` ${effect.due.direction}` : ""})
          </>
        ) : null}
      </div>
    );
  }
  if (effect.kind === "accumulation") {
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        accumulate <span className="mono">{renderExpr(effect.rate)}</span> per {effect.per}
      </div>
    );
  }
  if (effect.kind === "indemnification") {
    return (
      <div>
        {tagLabel ? <>{tagLabel} · </> : null}
        {effect.indemnifier ?? "party"} indemnifies {effect.indemnitee ?? "counterparty"}
        {effect.scope ? <> for {effect.scope}</> : null}
      </div>
    );
  }
  if (effect.kind === "default") {
    return (
      <>
        {tagLabel ? <div>{tagLabel}</div> : null}
        {effect.consequences?.length ? (
          <div style={{ marginTop: 4 }}>Consequences: {effect.consequences.join("; ")}</div>
        ) : null}
      </>
    );
  }
  if (effect.kind === "unmodeled") {
    return <div className="muted italic">(unmodeled — see source text)</div>;
  }
  return <div className="muted italic">{c.title ?? ""}</div>;
}

export default function Dossier({
  contracts,
  selectedContractKey,
  selectedSourceFile,
  meta,
  ir,
  contract,
  english,
  scenario,
  execution,
  selectedArchetype,
}: Props) {
  const router = useRouter();
  const [hover, setHover] = useState<Link>({});
  const [locked, setLocked] = useState<Link>({});
  const [liveExecution, setLiveExecution] = useState<RunResult | null>(execution);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [isGeneratingIr, setIsGeneratingIr] = useState(false);
  const [irError, setIrError] = useState<string | null>(null);
  const [isGeneratingScenarios, setIsGeneratingScenarios] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [isLoadingPreloaded, setIsLoadingPreloaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadFileName, setUploadFileName] = useState<string>("");
  const uploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLiveExecution(execution);
    setIsRunning(false);
    setRunError(null);
    setIsGeneratingIr(false);
    setIrError(null);
    setIsGeneratingScenarios(false);
    setScenarioError(null);
    setIsLoadingPreloaded(false);
  }, [selectedContractKey, selectedArchetype]);

  useEffect(() => {
    setUploading(false);
    setUploadError(null);
    setUploadFileName("");
    if (uploadRef.current) uploadRef.current.value = "";
  }, [selectedContractKey]);

  useEffect(() => {
    const clear = () => setLocked({});
    document.addEventListener("click", clear);
    return () => document.removeEventListener("click", clear);
  }, []);

  const linkClass = useCallback(
    (clauseId?: string, eventId?: string) => {
      const classes: string[] = [];
      const matchesHover =
        (clauseId && hover.clauseId === clauseId) ||
        (eventId && hover.eventId === eventId);
      const matchesLock =
        (clauseId && locked.clauseId === clauseId) ||
        (eventId && locked.eventId === eventId);
      if (matchesHover) classes.push(eventId && !clauseId ? "event-hover" : "linked-hover");
      if (matchesLock) classes.push("locked");
      return classes.join(" ");
    },
    [hover, locked],
  );

  const linkHandlers = useCallback(
    (clauseId?: string, eventId?: string) => ({
      onMouseEnter: () => setHover({ clauseId, eventId }),
      onMouseLeave: () => setHover({}),
      onClick: (evt: React.MouseEvent) => {
        evt.stopPropagation();
        setLocked((prev) =>
          prev.clauseId === clauseId && prev.eventId === eventId
            ? {}
            : { clauseId, eventId },
        );
      },
    }),
    [],
  );

  const hasIrArtifacts = Boolean(ir);
  const currency = ir?.currency ?? "USD";
  const summary = liveExecution?.summary ?? {};
  const runResultsVisible = Boolean(liveExecution);
  const scenarios = meta?.scenarios ?? [];
  const hasScenarioArtifacts = scenarios.length > 0;
  const hasEnglishArtifact = Boolean(english.trim());
  const selectedContract = contracts.find((contract) => contract.key === selectedContractKey);
  const scenarioAssumptions = scenario?.assumptions ?? [];
  const scenarioEvents = scenario?.events ?? [];
  const scenarioInitialStateEntries = useMemo(
    () => Object.entries(scenario?.initialState ?? {}) as Array<[string, unknown]>,
    [scenario],
  );
  const scenarioGeneration = scenario?.metadata?.generation;

  const englishBlocks = useMemo(() => {
    return english.split("\n").map((raw, i) => {
      if (!raw.trim()) return <span key={i} style={{ display: "block", height: 8 }} />;
      const m = raw.match(/^\s*-\s+(clause\.[a-z_.]+):\s*(.*)$/i);
      if (m) {
        const cid = m[1];
        return (
          <span
            key={i}
            className={`line clause-line ${linkClass(cid)}`}
            {...linkHandlers(cid)}
          >
            <span className="marker">§</span>
            <span className="cid">{cid}</span>
            {" — "}
            {m[2]}
          </span>
        );
      }
      const headMatch = /^(Parties:|Definitions:|Executable Clauses:|Modeled coverage.*)$/.exec(
        raw.trim(),
      );
      if (headMatch) {
        return (
          <span key={i} className="line head">
            {raw.trim()}
          </span>
        );
      }
      const isMeta = /^(Contract|Contract ID|Currency)/.test(raw);
      return (
        <span key={i} className={`line${isMeta ? " meta" : ""}`}>
          {raw}
        </span>
      );
    });
  }, [english, linkClass, linkHandlers]);

  const selectContract = (contractKey: string) => {
    if (contractKey !== selectedContractKey) {
      router.push(`/?contract=${encodeURIComponent(contractKey)}`);
    }
  };

  const selectScenario = (archetype: string) => {
    router.push(
      `/?contract=${encodeURIComponent(selectedContractKey)}&scenario=${encodeURIComponent(archetype)}`,
    );
  };

  const runNow = async () => {
    if (!selectedArchetype || isRunning || !hasIrArtifacts) return;
    setIsRunning(true);
    setRunError(null);
    try {
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractKey: selectedContractKey,
          archetype: selectedArchetype,
        }),
      });
      const payload = (await response.json()) as {
        execution?: RunResult;
        error?: string;
      };
      if (!response.ok || !payload.execution) {
        throw new Error(payload.error || "Execution request failed");
      }
      setLiveExecution(payload.execution);
      router.refresh();
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Execution failed");
    } finally {
      setIsRunning(false);
    }
  };

  const generateIr = async () => {
    if (isGeneratingIr) return;
    setIsGeneratingIr(true);
    setIrError(null);
    setScenarioError(null);
    setRunError(null);
    setLiveExecution(null);
    try {
      const response = await fetch("/api/run-contract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate-ir",
          contractKey: selectedContractKey,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "IR generation failed");
      }
      router.push(`/?contract=${encodeURIComponent(selectedContractKey)}`);
      router.refresh();
    } catch (error) {
      setIrError(error instanceof Error ? error.message : "IR generation failed");
    } finally {
      setIsGeneratingIr(false);
    }
  };

  const loadPreloaded = async () => {
    if (isLoadingPreloaded) return;
    setIsLoadingPreloaded(true);
    setScenarioError(null);
    setIrError(null);
    setRunError(null);
    setLiveExecution(null);
    try {
      const response = await fetch("/api/run-contract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "load-preloaded",
          contractKey: selectedContractKey,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Loading preloaded bundle failed");
      }
      router.push(`/?contract=${encodeURIComponent(selectedContractKey)}`);
      router.refresh();
    } catch (error) {
      setScenarioError(
        error instanceof Error ? error.message : "Loading preloaded bundle failed",
      );
    } finally {
      setIsLoadingPreloaded(false);
    }
  };

  const generateScenarios = async () => {
    if (isGeneratingScenarios || !hasIrArtifacts) return;
    setIsGeneratingScenarios(true);
    setScenarioError(null);
    setRunError(null);
    setLiveExecution(null);
    try {
      const response = await fetch("/api/run-contract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate-scenarios",
          contractKey: selectedContractKey,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Scenario generation failed");
      }
      router.push(`/?contract=${encodeURIComponent(selectedContractKey)}`);
      router.refresh();
    } catch (error) {
      setScenarioError(error instanceof Error ? error.message : "Scenario generation failed");
    } finally {
      setIsGeneratingScenarios(false);
    }
  };

  const uploadContract = async () => {
    const input = uploadRef.current;
    const file = input?.files?.[0];
    if (!file || uploading) return;

    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/upload-contract", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        contractKey?: string;
        error?: string;
      };
      if (!response.ok || !payload.ok || !payload.contractKey) {
        throw new Error(payload.error || "Upload failed");
      }
      router.push(`/?contract=${encodeURIComponent(payload.contractKey)}`);
      router.refresh();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <main className="sheet">
      <header className="topbar">
        <div>
          <div className="brand">Executable Contracts · pipeline viewer</div>
          <div className="contract-picker">
            <label htmlFor="contract-select">Contract</label>
            <select
              id="contract-select"
              value={selectedContractKey}
              onChange={(e) => selectContract(e.target.value)}
            >
              {contracts.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.title} {c.scenariosReady ? "[scenarios]" : c.irReady ? "[ir]" : "[raw]"}
                </option>
              ))}
            </select>
            <div className="pipeline-controls">
              <input
                ref={uploadRef}
                type="file"
                accept=".md,text/markdown,text/plain"
                onChange={(e) => {
                  setUploadError(null);
                  setUploadFileName(e.target.files?.[0]?.name ?? "");
                }}
              />
              <button
                type="button"
                className="execute-button"
                onClick={uploadContract}
                disabled={uploading || !uploadFileName}
              >
                {uploading ? "Uploading..." : "Upload Held-Out .md"}
              </button>
            </div>
            {uploadFileName ? (
              <div className="hint" style={{ marginTop: 6 }}>
                Selected upload: <span className="mono">{uploadFileName}</span>
              </div>
            ) : null}
            {uploadError ? (
              <div className="hint error" style={{ marginTop: 6 }}>
                {uploadError}
              </div>
            ) : null}
          </div>
        </div>
        <div className="meta">
          <div>key: <strong>{selectedContractKey}</strong></div>
          <div>source: {selectedSourceFile}</div>
          <div>origin: {selectedContract?.origin ?? "unknown"}</div>
          <div>ir: {hasIrArtifacts ? "ready" : "not generated"}</div>
          <div>scenarios: {hasScenarioArtifacts ? "ready" : "not generated"}</div>
          <div>english: {hasEnglishArtifact ? "ready" : "not generated"}</div>
          <div>
            {ir?.parties?.map((p) => p.name).slice(0, 2).join(" ↔ ") || "—"}
            {" · "}
            {currency}
            {ir?.metadata ? (
              <>
                {" "}
                · {ir?.metadata?.modeledClauseCount ?? 0}/{ir?.metadata?.clauseCount ?? 0} modeled
              </>
            ) : null}
          </div>
          {meta ? <div>family: {meta.family}</div> : null}
        </div>
      </header>

      <section className="zone">
        <div className="zone-label">
          Step 1 · Contract → IR
          <span className="hint">
            {" "}— parse contract markdown into executable clauses (run this first)
          </span>
        </div>
        <div className="pipeline-controls" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="execute-button"
            onClick={generateIr}
            disabled={isGeneratingIr}
          >
            {isGeneratingIr ? "Generating IR..." : "Generate IR"}
          </button>
          {irError ? <span className="hint error">{irError}</span> : null}
        </div>
        <div className="inputs">
          <div className="input-panel">
            <div className="head">
              <span className="label">contract.md</span>
              <span>markdown input</span>
            </div>
            <pre className="body">{contract || "(contract.md not found)"}</pre>
          </div>

          <details className="ir-drawer" style={{ marginTop: 0 }}>
            <summary>
              <strong>Show intermediate representation</strong>
              {" — "}
              {(ir?.clauses ?? []).length} clauses drive every scenario below
            </summary>
            <div className="ir-body">
              {(ir?.clauses ?? []).map((c) => (
                <div
                  key={c.id}
                  className={`article ${linkClass(c.id)}`}
                  {...linkHandlers(c.id)}
                >
                  <div className="art-head">
                    <span className={`art-kind ${c.effect?.kind ?? "unmodeled"}`}>
                      {c.effect?.kind ?? "unmodeled"}
                    </span>
                    <span className="art-id">{c.id}</span>
                  </div>
                  <div className="art-title">{c.title ?? c.id}</div>
                  <div className="art-body">
                    <ClauseBody c={c} />
                  </div>
                </div>
              ))}
              {(ir?.clauses ?? []).length === 0 ? (
                <div className="muted italic" style={{ padding: 12 }}>
                  (IR unavailable until "Generate IR" runs for this contract)
                </div>
              ) : null}
            </div>
          </details>
        </div>
      </section>

      <section className="zone">
        <div className="zone-label">
          Step 2 · Generate and Pick a Scenario
          <span className="hint">
            {" "}— create scenario artifacts from the IR, then choose one archetype
          </span>
        </div>
        <div className="pipeline-controls" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="execute-button"
            onClick={generateScenarios}
            disabled={!hasIrArtifacts || isGeneratingScenarios || isLoadingPreloaded}
          >
            {isGeneratingScenarios ? "Generating Scenarios..." : "Generate Scenarios"}
          </button>
          {selectedContract?.hasPreloaded ? (
            <button
              type="button"
              className="execute-button"
              onClick={loadPreloaded}
              disabled={isGeneratingScenarios || isLoadingPreloaded}
              title="Copy the committed hand-crafted bundle (IR, scenarios, executions, english) into this contract's web run."
            >
              {isLoadingPreloaded ? "Loading Preloaded..." : "Use Preloaded Bundle"}
            </button>
          ) : null}
          {scenarioError ? <span className="hint error">{scenarioError}</span> : null}
        </div>
        {scenarios.length === 0 ? (
          <div className="execute-prompt">
            <div className="hint">
              {selectedContract?.hasPreloaded
                ? 'No scenario artifacts yet. Click "Use Preloaded Bundle" to load the committed hand-crafted bundle, or "Generate Scenarios" (requires an OpenAI key).'
                : hasIrArtifacts
                  ? 'No scenario artifacts yet. Click "Generate Scenarios".'
                  : 'Generate IR first, then run "Generate Scenarios".'}
            </div>
          </div>
        ) : (
          <>
            <div className="scenarios">
              {scenarios.map((s) => {
                const isSelected = s.archetype === selectedArchetype;
                const hasScenarioExecution =
                  typeof s.endingBalance === "number" && typeof s.breached === "boolean";
                return (
                  <button
                    key={s.archetype}
                    type="button"
                    className={`scenario-card${isSelected ? " selected" : ""}`}
                    onClick={() => selectScenario(s.archetype)}
                    aria-pressed={isSelected}
                  >
                    <div className="run-id">{s.archetype}</div>
                    <div className="title">{s.label}</div>
                    <div className="events">
                      <span>{s.summary ?? s.scenarioId}</span>
                    </div>
                    <div className="foot">
                      <span className="bal">
                        {hasScenarioExecution ? fmtMoney(s.endingBalance, currency) : "not run"}
                      </span>
                      {s.breached === true ? (
                        <span className="breach-badge yes">breach</span>
                      ) : s.breached === false ? (
                        <span className="breach-badge no">clean</span>
                      ) : (
                        <span className="breach-badge pending">pending</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="scenario-details">
              {scenario ? (
                <>
                  <div className="scenario-details-head">
                    <div className="scenario-details-title">
                      {scenario.label ?? scenario.archetype ?? "Selected scenario"}
                    </div>
                    <div className="scenario-details-meta">
                      <span className="mono">{scenario.archetype ?? selectedArchetype ?? "—"}</span>
                      <span className="dot">·</span>
                      <span className="mono">{scenario.scenarioId ?? "—"}</span>
                      {scenarioGeneration?.mode ? (
                        <>
                          <span className="dot">·</span>
                          <span className="mono">mode={scenarioGeneration.mode}</span>
                        </>
                      ) : null}
                      {typeof scenarioGeneration?.promptTruncated === "boolean" ? (
                        <>
                          <span className="dot">·</span>
                          <span className="mono">
                            promptTruncated={String(scenarioGeneration.promptTruncated)}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="scenario-details-grid">
                    <div className="detail-section">
                      <div className="detail-label">
                        Assumptions ({scenarioAssumptions.length})
                      </div>
                      {scenarioAssumptions.length > 0 ? (
                        <ul className="scenario-list">
                          {scenarioAssumptions.map((assumption, idx) => (
                            <li key={`${idx}-${assumption}`}>{assumption}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="muted italic">(none)</div>
                      )}
                    </div>
                    <div className="detail-section">
                      <div className="detail-label">
                        Initial State ({scenarioInitialStateEntries.length})
                      </div>
                      {scenarioInitialStateEntries.length > 0 ? (
                        <div className="state-kv">
                          {scenarioInitialStateEntries.map(([key, value]) => (
                            <div key={key} className="state-row">
                              <span className="state-key mono">{key}</span>
                              <span className="state-value mono">{fmtScenarioValue(value)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="muted italic">(none)</div>
                      )}
                    </div>
                  </div>
                  <div className="detail-section" style={{ marginTop: 12 }}>
                    <div className="detail-label">Event Timeline ({scenarioEvents.length})</div>
                    {scenarioEvents.length > 0 ? (
                      <div className="scenario-events">
                        <div className="scenario-events-head">
                          <span>ID</span>
                          <span>Date</span>
                          <span>Type</span>
                          <span className="r">Amount</span>
                        </div>
                        {scenarioEvents.map((event) => (
                          <div key={event.id} className="scenario-events-block">
                            <div className="scenario-events-row">
                              <span className="mono">{event.id}</span>
                              <span className="mono">{fmtDate(event.date)}</span>
                              <span className="mono">{event.type}</span>
                              <span className="mono r">{fmtNumber(event.amount)}</span>
                            </div>
                            {event.metadata && Object.keys(event.metadata).length > 0 ? (
                              <pre className="scenario-event-meta">
                                {JSON.stringify(event.metadata, null, 2)}
                              </pre>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="muted italic">(none)</div>
                    )}
                  </div>
                </>
              ) : (
                <div className="hint">
                  Select a scenario card above to inspect assumptions, initial state, and event data.
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <section className="zone">
        <div className="zone-label">
          Step 3 · Run the contract
          <span className="hint">
            {" "}— apply the IR to the selected scenario; results are computed by the runtime (no LLM)
          </span>
        </div>

        <div className="execute-prompt">
          <button
            type="button"
            className="execute-button"
            onClick={runNow}
            disabled={!selectedArchetype || isRunning || !hasIrArtifacts}
          >
            {isRunning ? "Running..." : "▶ Run"}{" "}
            <span className="mono">{selectedArchetype ?? ""}</span>{" "}
            against <span className="mono">{selectedContractKey}</span>
          </button>
          <div className="hint spaced">
            {scenario ? (
              <>
                Will replay {scenario.events?.length ?? 0} events and{" "}
                {scenario.assumptions?.length ?? 0} assumptions through the runtime.
              </>
            ) : (
              <>
                {hasScenarioArtifacts
                  ? 'Select a scenario above to enable execution, then Step 4 will generate "english.txt".'
                  : hasIrArtifacts
                    ? 'Generate scenarios first (Step 2), then click "Run".'
                    : "Generate IR first (Step 1)."}
              </>
            )}
          </div>
          {runError ? <div className="hint error spaced">{runError}</div> : null}
        </div>

        {runResultsVisible ? (
          <>
            <div className="exec-ribbon">
              <div className="exec-cell">
                <div className="k">Ending balance</div>
                <div className="v">{fmtMoney(summary.endingBalance, currency)}</div>
              </div>
              <div className="exec-cell">
                <div className="k">Total paid</div>
                <div className="v">{fmtMoney(summary.totalPaid, currency)}</div>
              </div>
              <div className="exec-cell">
                <div className="k">Interest charged</div>
                <div className="v">{fmtMoney(summary.totalInterestCharged, currency)}</div>
              </div>
              <div className="exec-cell">
                <div className="k">Fees charged</div>
                <div className="v">{fmtMoney(summary.totalFeesCharged, currency)}</div>
              </div>
              <div className="exec-cell">
                <div className="k">Breach</div>
                <div
                  className={
                    "v" +
                    (summary.breached === true
                      ? " breach-yes"
                      : summary.breached === false
                        ? " breach-no"
                        : "")
                  }
                >
                  {summary.breached === true
                    ? "yes"
                    : summary.breached === false
                      ? "none"
                      : "—"}
                </div>
              </div>
            </div>

            <div className="ledger">
              <div className="led-head">
                <div>Date</div>
                <div>Description</div>
                <div className="r">Amount</div>
                <div className="r">Balance</div>
              </div>
              <div>
                {(liveExecution?.ledger ?? []).map((ent: LedgerEntry) => {
                  const evMatch = /(evt-\d+)/.exec(ent.id ?? "");
                  const eventId = evMatch ? evMatch[1] : undefined;
                  const amtCls = ent.amount < 0 ? "neg" : "pos";
                  return (
                    <div
                      key={ent.id}
                      className={`led-row ${linkClass(ent.clauseId, eventId)}`}
                      {...linkHandlers(ent.clauseId, eventId)}
                    >
                      <span className="d">{fmtDate(ent.date)}</span>
                      <span>
                        <span className="k">{ent.kind}</span>{" "}
                        <span className="dsc">{ent.description ?? ""}</span>
                      </span>
                      <span className={`amt ${amtCls}`}>
                        {fmtMoney(ent.amount, currency)}
                      </span>
                      <span className="bal">
                        {fmtMoney(ent.balanceAfter, currency)}
                      </span>
                    </div>
                  );
                })}
                {(liveExecution?.ledger ?? []).length === 0 ? (
                  <div className="muted italic" style={{ padding: 12 }}>
                    (no ledger entries)
                  </div>
                ) : null}
              </div>
            </div>

            <div className="obls">
              {(liveExecution?.obligations ?? []).map((o: Obligation) => (
                <div
                  key={o.id}
                  className={`obl ${o.status === "missed" ? "breach" : ""} ${linkClass(o.clauseId)}`}
                  {...linkHandlers(o.clauseId)}
                >
                  <div>
                    <div className="o-title">Obligation · {o.clauseId}</div>
                    <div className="o-amt">
                      due {fmtMoney(o.amountDue, currency)} · paid{" "}
                      {fmtMoney(o.amountPaid, currency)} · by {fmtDate(o.dueDate)}
                    </div>
                  </div>
                  <div className="o-status">{o.status ?? "—"}</div>
                </div>
              ))}
              {(liveExecution?.breaches ?? []).map((b: Breach) => (
                <div
                  key={b.id}
                  className={`breach-note ${linkClass(b.clauseId)}`}
                  {...linkHandlers(b.clauseId)}
                >
                  <strong>Breach:</strong> {b.description}
                  <span className="meta">
                    on {fmtDate(b.date)} · {b.clauseId}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section className="zone">
        <div className="zone-label">
          Step 4 · Deterministic executable → English
          <span className="hint">
            {" "}— generated after Step 3 from IR + scenario inputs + runtime outputs; no LLM
          </span>
        </div>
        <div className="input-panel">
          <div className="head">
            <span className="label">english.txt</span>
            <span>derived after runtime execution</span>
          </div>
          <div className="english-body">
            {hasEnglishArtifact ? (
              englishBlocks
            ) : (
              <span className="line muted italic">
                Run Step 3 to generate `english.txt`.
              </span>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
