import type { Database } from "sql.js";

import {
  AGENT_CONTRACT_VERSION,
  MAX_EXPERIMENTS,
  MIN_RECOMMENDED_SPEEDUP,
  reviewerInputSchema,
  strategistInputSchema,
  tuningReportSchema,
  type Baseline,
  type ReviewerInput,
  type ReviewerOutput,
  type RunMode,
  type StrategistDecision,
  type StrategistExperimentEvidence,
  type StrategistInput,
  type TuningReport,
} from "./contracts";
import { createDemoDatabase } from "./demo-database";
import { chooseNextExperiment, reviewTuningOutcome } from "./planner";
import {
  benchmarkQuery,
  cloneDatabase,
  explainQuery,
  getSqlJs,
  inspectResult,
  readSchema,
  resultsAreEquivalent,
} from "./sqlite-engine";
import { validateCreateIndex, validateReadOnlyQuery } from "./sql-safety";

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : "The candidate could not be evaluated.";
}

function speedupFor(baselineMs: number, candidateMs: number): number {
  if (candidateMs <= 0) return 1;
  return Math.max(0.001, baselineMs / candidateMs);
}

function makeBaseline(database: Database, query: string): Baseline {
  const result = inspectResult(database, query);
  if (result.exceededRowLimit) {
    throw new Error("The query returns more than 10,000 rows, so complete equivalence cannot be proven.");
  }
  return {
    query,
    plan: explainQuery(database, query),
    result,
    benchmark: benchmarkQuery(database, query),
  };
}

type PlannerDependencies = {
  chooseNextExperiment: (mode: RunMode, input: StrategistInput) => Promise<StrategistDecision>;
  reviewTuningOutcome: (mode: RunMode, input: ReviewerInput) => Promise<ReviewerOutput>;
};

function indexKeyFromSql(sql: string, schema: ReturnType<typeof readSchema>): string {
  const index = validateCreateIndex(sql, schema);
  return `index:${index.table.toLowerCase()}:${[...index.columns]
    .map((column) => column.toLowerCase())
    .sort()
    .join(",")}`;
}

function candidateKey(decision: StrategistDecision, schema: ReturnType<typeof readSchema>): string | undefined {
  if (decision.action === "conclude") return undefined;
  if (decision.action === "rewrite_query") {
    return `rewrite:${validateReadOnlyQuery(decision.sql).trim().toLowerCase()}`;
  }
  return indexKeyFromSql(decision.indexSql, schema);
}

function experimentKey(experiment: StrategistExperimentEvidence, schema: ReturnType<typeof readSchema>): string | undefined {
  if (experiment.kind === "rewrite_query") {
    return `rewrite:${validateReadOnlyQuery(experiment.candidateSql).trim().toLowerCase()}`;
  }
  return indexKeyFromSql(experiment.candidateSql, schema);
}

export function selectWinningExperiment(
  experiments: StrategistExperimentEvidence[],
): StrategistExperimentEvidence | undefined {
  return experiments
    .filter((experiment) => experiment.verdict === "improved" && (experiment.speedup ?? 0) >= MIN_RECOMMENDED_SPEEDUP)
    .sort((a, b) => (b.speedup ?? 0) - (a.speedup ?? 0))[0];
}

export async function tuneQueryWithDependencies(
  rawQuery: string,
  mode: RunMode,
  dependencies: PlannerDependencies,
  databaseBytes?: Uint8Array,
): Promise<TuningReport> {
  let query: string;
  try {
    query = validateReadOnlyQuery(rawQuery);
  } catch (error) {
    return tuningReportSchema.parse({
      status: "invalid-input",
      originalQuery: rawQuery,
      experiments: [],
      conclusion: summarizeError(error),
      caveats: [],
    });
  }

  const SQL = await getSqlJs();
  const source = databaseBytes ? new SQL.Database(databaseBytes) : createDemoDatabase(SQL);

  try {
    const schema = readSchema(source);
    const baseline = makeBaseline(source, query);
    const experiments: StrategistExperimentEvidence[] = [];

    for (let number = 1; number <= MAX_EXPERIMENTS; number += 1) {
      const strategistInput = strategistInputSchema.parse({
        contractVersion: AGENT_CONTRACT_VERSION,
        originalQuery: query,
        schema,
        baseline,
        experiments,
        attemptedStrategies: experiments.map((experiment) => experiment.strategy),
        remainingExperiments: MAX_EXPERIMENTS - experiments.length,
      });
      const decision = await dependencies.chooseNextExperiment(mode, strategistInput);
      if (decision.action === "conclude") break;

      const candidateSql = decision.action === "rewrite_query" ? decision.sql : decision.indexSql;
      let currentKey: string | undefined;
      try {
        currentKey = candidateKey(decision, schema);
      } catch {
        currentKey = undefined;
      }
      const repeated = experiments.some(
        (experiment) => {
          const sameSql = experiment.candidateSql.trim().toLowerCase() === candidateSql.trim().toLowerCase();
          if (sameSql || !currentKey) return sameSql;
          try {
            return experimentKey(experiment, schema) === currentKey;
          } catch {
            return false;
          }
        },
      );
      if (repeated) break;

      let candidateDatabase: Database | undefined;
      try {
        candidateDatabase = cloneDatabase(SQL, source);
        let queryToRun = query;
        if (decision.action === "rewrite_query") {
          queryToRun = validateReadOnlyQuery(decision.sql);
        } else {
          const validated = validateCreateIndex(decision.indexSql, schema);
          candidateDatabase.run(validated.sql);
        }

        const result = inspectResult(candidateDatabase, queryToRun);
        const equivalent = resultsAreEquivalent(baseline.result, result);
        if (!equivalent) {
          experiments.push({
            number,
            kind: decision.action,
            strategy: decision.strategy,
            hypothesis: decision.hypothesis,
            candidateSql,
            expectedPlanChange: decision.expectedPlanChange,
            verdict: "non-equivalent",
            failureClass: "equivalence",
            summary: "Rejected because the complete result differs from the baseline.",
            observation: "The candidate changed the complete result set and cannot be recommended.",
            adaptation: decision.adaptation,
            result,
            equivalence: false,
          });
          continue;
        }

        const plan = explainQuery(candidateDatabase, queryToRun);
        const benchmark = benchmarkQuery(candidateDatabase, queryToRun);
        const speedup = speedupFor(baseline.benchmark.medianMs, benchmark.medianMs);
        const verdict = speedup >= MIN_RECOMMENDED_SPEEDUP
          ? "improved"
          : speedup < 0.95
            ? "slower"
            : "equivalent-noise";
        experiments.push({
          number,
          kind: decision.action,
          strategy: decision.strategy,
          hypothesis: decision.hypothesis,
          candidateSql,
          expectedPlanChange: decision.expectedPlanChange,
          verdict,
          failureClass: verdict === "improved" ? "none" : "performance",
          summary: verdict === "improved"
            ? `Equivalent results verified; median runtime improved by ${((1 - 1 / speedup) * 100).toFixed(1)}%.`
            : "Equivalent results verified, but the candidate did not clear the 10% improvement threshold.",
          observation: verdict === "improved"
            ? `Experiment ${number} preserved all results and measured ${speedup.toFixed(2)}x faster than baseline.`
            : `Experiment ${number} preserved all results but measured ${speedup.toFixed(2)}x versus baseline.`,
          adaptation: decision.adaptation,
          plan,
          result,
          benchmark,
          equivalence: true,
          speedup,
        });
      } catch (error) {
        const guardRejected = error instanceof Error
          && /allowed|blocked|unknown|single|statement/i.test(error.message);
        experiments.push({
          number,
          kind: decision.action,
          strategy: decision.strategy,
          hypothesis: decision.hypothesis,
          candidateSql,
          expectedPlanChange: decision.expectedPlanChange,
          verdict: guardRejected ? "guard-rejected" : "execution-failed",
          failureClass: guardRejected ? "safety" : "execution",
          summary: summarizeError(error),
          observation: guardRejected
            ? "The deterministic SQL safety guard rejected this candidate before execution."
            : "The candidate failed during isolated execution and produced no valid measurement.",
          adaptation: decision.adaptation,
        });
      } finally {
        candidateDatabase?.close();
      }
    }

    const winner = selectWinningExperiment(experiments);
    const deterministicOutcome = winner ? "improved" : "no-proven-improvement";
    const reviewerInput = reviewerInputSchema.parse({
      contractVersion: AGENT_CONTRACT_VERSION,
      originalQuery: query,
      baseline,
      experiments,
      deterministicOutcome,
      winningExperimentNumber: winner?.number,
    });
    const review = await dependencies.reviewTuningOutcome(mode, reviewerInput);

    return tuningReportSchema.parse({
      status: deterministicOutcome,
      originalQuery: query,
      baseline,
      experiments,
      winner,
      review,
      conclusion: winner
        ? `A ${winner.speedup?.toFixed(2)}x faster, result-equivalent candidate was proven in isolation.`
        : "No candidate cleared the 10% measured improvement threshold.",
      caveats: [
        "Measurements use an in-memory SQLite demo database and should be confirmed on representative production data.",
        "A recommendation is returned only after complete bounded result equivalence and repeated timing checks.",
      ],
    });
  } catch (error) {
    return tuningReportSchema.parse({
      status: "failed",
      originalQuery: query,
      experiments: [],
      conclusion: summarizeError(error),
      caveats: [],
    });
  } finally {
    source.close();
  }
}

export async function tuneQuery(
  rawQuery: string,
  mode: RunMode,
  databaseBytes?: Uint8Array,
): Promise<TuningReport> {
  return tuneQueryWithDependencies(rawQuery, mode, {
    chooseNextExperiment,
    reviewTuningOutcome,
  }, databaseBytes);
}
