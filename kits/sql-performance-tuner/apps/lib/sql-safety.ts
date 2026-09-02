import type { TableSchema } from "./contracts";
import { MAX_QUERY_CHARACTERS } from "./contracts";

const FORBIDDEN_QUERY_TOKENS = /\b(?:attach|detach|pragma|vacuum|insert|update|delete|replace|drop|alter|create|reindex|analyze|load_extension)\b/i;
const NONDETERMINISTIC_TOKENS = /\b(?:random|randomblob|current_timestamp|current_date|current_time)\b|datetime\s*\(\s*['"]now['"]/i;
const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function withoutTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}

export function validateReadOnlyQuery(sql: string): string {
  const query = sql.trim();

  if (!query) throw new Error("Enter a SQL query.");
  if (query.length > MAX_QUERY_CHARACTERS) throw new Error("The query is too large for this bounded runner.");
  if (/--|\/\*/.test(query)) throw new Error("SQL comments are not accepted.");

  const normalized = withoutTrailingSemicolon(query);
  if (normalized.includes(";")) throw new Error("Only one SQL statement is allowed.");
  if (!/^(?:select|with)\b/i.test(normalized)) throw new Error("Only SELECT and WITH queries are allowed.");
  if (FORBIDDEN_QUERY_TOKENS.test(normalized)) throw new Error("The query contains a blocked database operation.");
  if (NONDETERMINISTIC_TOKENS.test(normalized)) throw new Error("Non-deterministic SQL functions cannot be compared safely.");

  return normalized;
}

export type ValidatedIndex = {
  sql: string;
  name: string;
  table: string;
  columns: string[];
};

export function validateCreateIndex(sql: string, schema: TableSchema[]): ValidatedIndex {
  const normalized = withoutTrailingSemicolon(sql);
  if (/--|\/\*/.test(normalized) || normalized.includes(";")) {
    throw new Error("The index candidate must contain exactly one statement without comments.");
  }

  const match = normalized.match(
    /^create\s+index\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+on\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)$/i,
  );
  if (!match) throw new Error("Only a simple CREATE INDEX ... ON table(column, ...) statement is allowed.");

  const [, name, tableName, rawColumns] = match;
  const columns = rawColumns.split(",").map((column) => column.trim());
  if (!columns.length || columns.some((column) => !SIMPLE_IDENTIFIER.test(column))) {
    throw new Error("Index columns must be plain existing column names.");
  }

  const table = schema.find((candidate) => candidate.name.toLowerCase() === tableName.toLowerCase());
  if (!table) throw new Error(`Index candidate references unknown table "${tableName}".`);
  const available = new Set(table.columns.map((column) => column.name.toLowerCase()));
  const unknown = columns.find((column) => !available.has(column.toLowerCase()));
  if (unknown) throw new Error(`Index candidate references unknown column "${unknown}".`);

  return { sql: `${normalized};`, name, table: table.name, columns };
}

export function queryHasExplicitOrder(sql: string): boolean {
  return /\border\s+by\b/i.test(sql);
}
