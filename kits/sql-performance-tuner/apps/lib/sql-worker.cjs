const { createHash } = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");

function canonicalCell(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  return value;
}

function firstResult(database, sql, maxRows) {
  const results = database.exec(sql, { maxRows });
  return results[0] || { columns: [], values: [] };
}

function inspectResult(database, sql) {
  const result = firstResult(database, sql, workerData.maxResultRows + 1);
  const exceededRowLimit = result.values.length > workerData.maxResultRows;
  if (exceededRowLimit) {
    return {
      columns: result.columns,
      rowCount: result.values.length,
      ordered: workerData.ordered,
      hash: "row-limit-exceeded",
      exceededRowLimit: true,
    };
  }

  const rows = result.values.map((row) => JSON.stringify(row.map(canonicalCell)));
  if (!workerData.ordered) rows.sort();
  return {
    columns: result.columns,
    rowCount: rows.length,
    ordered: workerData.ordered,
    hash: createHash("sha256").update(JSON.stringify([result.columns, rows])).digest("hex"),
    exceededRowLimit: false,
  };
}

function explainQuery(database, sql) {
  const result = firstResult(database, `EXPLAIN QUERY PLAN ${sql}`, workerData.maxResultRows + 1);
  return result.values.map((row) => ({
    id: Number(row[0]),
    parentId: Number(row[1]),
    detail: String(row[3]),
  }));
}

function benchmarkQuery(database, sql) {
  for (let run = 0; run < workerData.warmupRuns; run += 1) database.exec(sql);
  const measuredRuns = [];
  for (let run = 0; run < workerData.measuredRuns; run += 1) {
    const startedAt = performance.now();
    database.exec(sql);
    measuredRuns.push(Number((performance.now() - startedAt).toFixed(3)));
  }
  const sorted = [...measuredRuns].sort((left, right) => left - right);
  return {
    warmupRuns: workerData.warmupRuns,
    measuredRuns,
    medianMs: sorted[Math.floor(sorted.length / 2)] || 0,
  };
}

function readSchema(database) {
  const tables = database.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )[0]?.values || [];

  return tables.map(([rawName]) => {
    const name = String(rawName);
    const escaped = name.replace(/'/g, "''");
    const columns = (database.exec(`PRAGMA table_info('${escaped}')`)[0]?.values || []).map((row) => ({
      name: String(row[1]),
      declaredType: String(row[2] || "BLOB"),
      nullable: !Boolean(row[3]),
      primaryKeyPosition: Number(row[5]),
    }));
    const indexes = (database.exec(`PRAGMA index_list('${escaped}')`)[0]?.values || []).map((row) => {
      const indexName = String(row[1]);
      const indexEscaped = indexName.replace(/'/g, "''");
      const indexColumns = (database.exec(`PRAGMA index_info('${indexEscaped}')`)[0]?.values || [])
        .map((column) => String(column[2]));
      return { name: indexName, columns: indexColumns, unique: Boolean(row[2]) };
    });
    const quotedName = name.replace(/"/g, '""');
    const count = database.exec(`SELECT COUNT(*) FROM "${quotedName}"`)[0]?.values[0]?.[0];
    return { name, columns, indexes, estimatedRows: Number(count || 0) };
  });
}

async function main() {
  const imported = require(workerData.sqlJsModulePath);
  const initSqlJs = imported.default || imported;
  const SQL = await initSqlJs({ locateFile: () => workerData.wasmPath });
  const database = new SQL.Database(new Uint8Array(workerData.databaseBytes));
  try {
    if (workerData.indexSql) database.run(workerData.indexSql);
    const result = inspectResult(database, workerData.query);
    const response = { result };
    if (workerData.includeSchema) response.schema = readSchema(database);
    if (!result.exceededRowLimit) {
      response.plan = explainQuery(database, workerData.query);
      response.benchmark = benchmarkQuery(database, workerData.query);
    }
    parentPort.postMessage({ ok: true, value: response });
  } finally {
    database.close();
  }
}

main().catch((error) => {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : "SQLite worker failed.",
  });
});
