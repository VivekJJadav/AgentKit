import { Lamatic } from "lamatic";
import { z } from "zod";

import {
  AGENT_CONTRACT_VERSION,
  MAX_EXPERIMENTS,
  reviewerOutputSchema,
  strategistDecisionSchema,
  strategistStrategySchema,
  type ReviewerInput,
  type ReviewerOutput,
  type RunMode,
  type StrategistDecision,
  type StrategistInput,
} from "./contracts";

let client: Lamatic | undefined;

function unwrapFlowResult(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    const record = current as Record<string, unknown>;
    const next = record.output ?? record.result ?? record.data;
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function getLiveClient(): Lamatic {
  if (client) return client;
  const endpoint = process.env.LAMATIC_API_URL?.trim();
  const projectId = process.env.LAMATIC_PROJECT_ID?.trim();
  const apiKey = process.env.LAMATIC_API_KEY?.trim();

  if (!endpoint || !projectId || !apiKey) {
    throw new Error("Live mode needs LAMATIC_API_URL, LAMATIC_PROJECT_ID, and LAMATIC_API_KEY.");
  }

  client = new Lamatic({ endpoint, projectId, apiKey });
  return client;
}

function ensureLiveEnabled(): void {
  if (process.env.SQL_TUNER_ALLOW_LIVE !== "true") {
    throw new Error("Live Lamatic calls are disabled. Set SQL_TUNER_ALLOW_LIVE=true.");
  }
}

async function executeLiveFlow(flowName: string, flowId: string | undefined, input: object): Promise<unknown> {
  ensureLiveEnabled();
  if (!flowId?.trim()) throw new Error(`Live mode needs ${flowName}.`);
  const raw = await getLiveClient().executeFlow(flowId, input);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const response = raw as unknown as Record<string, unknown>;
    if (response.status === "error" || response.result === null) {
      const message = typeof response.message === "string" ? response.message : "Lamatic returned an empty result.";
      throw new Error(`Lamatic ${flowName} request failed: ${message}`);
    }
  }
  return unwrapFlowResult(raw);
}

const scalarCsvSchema = z.union([z.string(), z.number()]).optional().default("");

const strategistEnvelopeSchema = z.object({
  action: z.enum(["create_index", "rewrite_query", "conclude"]),
  strategy: strategistStrategySchema,
  hypothesis: z.string().optional().default(""),
  expectedPlanChange: z.string().optional().default(""),
  sql: z.string().optional().default(""),
  indexSql: z.string().optional().default(""),
  adaptation: z.object({
    learnedFromEvidence: z.string().optional().default("No prior measured evidence was available."),
    differsFromPrevious: z.string().optional().default("This is the first proposed experiment."),
    respondsToExperiment: z.coerce.number().int().nonnegative().optional().default(0),
  }).optional().default({}),
  stopCondition: z.string().optional().default("Stop if the candidate is unsafe, changes results, or is not at least 1.10x faster."),
  conclusionCode: z.enum([
    "winner_found",
    "budget_exhausted",
    "no_safe_distinct_experiment",
    "insufficient_evidence",
  ]).optional().default("insufficient_evidence"),
  reasoning: z.string().optional().default("The strategist concluded the bounded search."),
  evidenceUsedCsv: scalarCsvSchema,
});

function parseEvidenceCsv(value: string | number): number[] {
  return String(value)
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item, index, all) => Number.isInteger(item) && item > 0 && item <= MAX_EXPERIMENTS
      && all.indexOf(item) === index);
}

function normalizeStrategistDecision(value: unknown): StrategistDecision {
  const envelope = strategistEnvelopeSchema.parse(value);
  if (envelope.action === "conclude") {
    return strategistDecisionSchema.parse({
      contractVersion: AGENT_CONTRACT_VERSION,
      action: envelope.action,
      strategy: "conclude",
      conclusionCode: envelope.conclusionCode,
      reasoning: envelope.reasoning,
      evidenceUsed: parseEvidenceCsv(envelope.evidenceUsedCsv),
    });
  }

  const respondsToExperiment = envelope.adaptation.respondsToExperiment > 0
    ? envelope.adaptation.respondsToExperiment
    : undefined;
  return strategistDecisionSchema.parse({
    contractVersion: AGENT_CONTRACT_VERSION,
    action: envelope.action,
    strategy: envelope.strategy,
    hypothesis: envelope.hypothesis,
    expectedPlanChange: envelope.expectedPlanChange,
    ...(envelope.action === "create_index" ? { indexSql: envelope.indexSql } : { sql: envelope.sql }),
    adaptation: {
      learnedFromEvidence: envelope.adaptation.learnedFromEvidence,
      differsFromPrevious: envelope.adaptation.differsFromPrevious,
      respondsToExperiment,
    },
    stopConditions: [envelope.stopCondition],
  });
}

async function callStrategist(input: StrategistInput): Promise<StrategistDecision> {
  const raw = await executeLiveFlow(
    "SQL_TUNER_STRATEGIST_FLOW_ID",
    process.env.SQL_TUNER_STRATEGIST_FLOW_ID,
    input,
  );
  return normalizeStrategistDecision(raw);
}

function demoDecision(input: StrategistInput): StrategistDecision {
  if (input.experiments.length > 0 || input.remainingExperiments === 0) {
    const improved = input.experiments.find((experiment) => experiment.verdict === "improved");
    return {
      contractVersion: AGENT_CONTRACT_VERSION,
      action: "conclude",
      strategy: "conclude",
      conclusionCode: input.remainingExperiments === 0 ? "budget_exhausted" : "no_safe_distinct_experiment",
      reasoning: improved
        ? `The measured experiment produced a proven ${improved.speedup?.toFixed(2)}x speedup.`
        : "The bounded demo planner has no additional distinct high-confidence experiment.",
      evidenceUsed: input.experiments.map((experiment) => experiment.number),
    };
  }

  const tableMatch = input.originalQuery.match(/\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  const table = input.schema.find(
    (candidate) => candidate.name.toLowerCase() === tableMatch?.[1]?.toLowerCase(),
  );
  if (!table) return {
    contractVersion: AGENT_CONTRACT_VERSION,
    action: "conclude",
    strategy: "conclude",
    conclusionCode: "insufficient_evidence",
    reasoning: "No unambiguous base table was found.",
    evidenceUsed: [],
  };

  const whereColumn = input.originalQuery.match(/\bwhere\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|>=|<=|>|<|between\b)/i)?.[1]?.split(".").pop();
  const groupColumns = input.originalQuery.match(/\bgroup\s+by\s+([^;]+)/i)?.[1]
    ?.split(/\border\s+by\b/i)[0]
    .split(",")
    .map((column) => column.trim().split(".").pop() ?? "") ?? [];
  const aggregateColumns = Array.from(
    input.originalQuery.matchAll(/\b(?:sum|avg|min|max)\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/gi),
  )
    .map((match) => match[1].split(".").pop() ?? "");
  const available = new Set(table.columns.map((column) => column.name.toLowerCase()));
  const columns = [whereColumn, ...groupColumns, ...aggregateColumns]
    .filter((column): column is string => Boolean(column))
    .filter((column, index, all) => all.findIndex((item) => item.toLowerCase() === column.toLowerCase()) === index)
    .filter((column) => available.has(column.toLowerCase()));

  if (!whereColumn || columns.length === 0) {
    return {
      contractVersion: AGENT_CONTRACT_VERSION,
      action: "conclude",
      strategy: "conclude",
      conclusionCode: "no_safe_distinct_experiment",
      reasoning: "The demo planner could not derive a safe index candidate.",
      evidenceUsed: [],
    };
  }

  const indexName = `idx_${table.name}_${columns.join("_")}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    action: "create_index",
    strategy: "filter_first_index",
    hypothesis: `Indexing ${columns.join(", ")} should replace the full scan with an index search and cover the selected values.`,
    expectedPlanChange: `SCAN ${table.name} -> SEARCH ${table.name} USING COVERING INDEX`,
    indexSql: `CREATE INDEX ${indexName} ON ${table.name}(${columns.join(", ")});`,
    adaptation: {
      learnedFromEvidence: "No prior experiment evidence exists, so this tests the most selective safe index candidate.",
      differsFromPrevious: "This is the first proposed experiment.",
    },
    stopConditions: ["Stop if results differ or the candidate is not at least 1.10x faster."],
  };
}

export const reviewerEnvelopeSchema = z.object({
  outcome: z.enum(["improved", "no_proven_improvement"]),
  headline: z.string().min(1),
  evidenceSummary: z.string().min(1),
  recommendation: z.string().min(1),
  limitationsText: z.string().min(1),
  citedExperimentsCsv: scalarCsvSchema,
});

export function normalizeReviewerOutput(raw: unknown, input: ReviewerInput): ReviewerOutput {
  const envelope = reviewerEnvelopeSchema.parse(raw);
  const expectedOutcome = input.deterministicOutcome === "no-proven-improvement"
    ? "no_proven_improvement"
    : "improved";
  if (envelope.outcome !== expectedOutcome) {
    throw new Error("Lamatic reviewer contradicted the deterministic outcome.");
  }
  return reviewerOutputSchema.parse({
    contractVersion: AGENT_CONTRACT_VERSION,
    headline: envelope.headline,
    evidenceSummary: envelope.evidenceSummary,
    recommendation: envelope.recommendation,
    limitations: [envelope.limitationsText],
    citedExperiments: parseEvidenceCsv(envelope.citedExperimentsCsv),
  });
}

async function callReviewer(input: ReviewerInput): Promise<ReviewerOutput> {
  const payload = {
    originalQuery: input.originalQuery,
    baseline: input.baseline,
    experiments: input.experiments,
    deterministicOutcome: input.deterministicOutcome === "no-proven-improvement"
      ? "no_proven_improvement"
      : "improved",
    winningExperimentNumber: input.winningExperimentNumber ?? 0,
  };
  const raw = await executeLiveFlow(
    "SQL_TUNER_REVIEWER_FLOW_ID",
    process.env.SQL_TUNER_REVIEWER_FLOW_ID,
    payload,
  );
  return normalizeReviewerOutput(raw, input);
}

function demoReview(input: ReviewerInput): ReviewerOutput {
  const winner = input.experiments.find((experiment) => experiment.number === input.winningExperimentNumber);
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    headline: winner
      ? `Experiment ${winner.number} produced a proven ${winner.speedup?.toFixed(2)}x speedup`
      : "No measured improvement was proven",
    evidenceSummary: winner
      ? `${winner.summary} The complete bounded result remained equivalent to the baseline.`
      : `${input.experiments.length} bounded experiment${input.experiments.length === 1 ? " was" : "s were"} evaluated without a proven winner.`,
    recommendation: winner ? `Use the measured candidate: ${winner.candidateSql}` : "Keep the original query.",
    limitations: ["Confirm local sandbox measurements on representative production data."],
    citedExperiments: input.experiments.map((experiment) => experiment.number),
  };
}

export async function chooseNextExperiment(mode: RunMode, input: StrategistInput): Promise<StrategistDecision> {
  return mode === "live" ? callStrategist(input) : demoDecision(input);
}

export async function reviewTuningOutcome(mode: RunMode, input: ReviewerInput): Promise<ReviewerOutput> {
  return mode === "live" ? callReviewer(input) : demoReview(input);
}
