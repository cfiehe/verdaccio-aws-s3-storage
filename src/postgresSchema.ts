import type {S3Config} from '../types';

/**
 * Single source of truth for the Postgres registry-state schema. The table names
 * are derived from a configurable prefix; both the runtime DDL (autoCreateSchema)
 * and the db/schema.sql artifact (scripts/print-schema.ts) are generated from here,
 * so there is exactly one place that defines the layout.
 */

/**
 * Default prefix: none. With `postgres.tablePrefix` unset (or an empty string) the
 * tables are the bare names `config`, `packages`, `tokens` — all non-reserved and
 * valid unquoted. Set a prefix to namespace them within a shared database.
 */
export const DEFAULT_TABLE_PREFIX = '';

/**
 * A non-empty prefix is restricted to the lower-case identifier charset. Unquoted
 * Postgres identifiers fold to lower case, and a table name is interpolated into
 * DDL/DML — an identifier cannot be a bound parameter — so this allowlist is also
 * the SQL-injection boundary: a non-empty prefix that does not match is rejected
 * before it can reach a statement. The empty string is allowed and means "no prefix".
 */
const PREFIX_RE = /^[a-z_][a-z0-9_]*$/;

export interface PostgresTables {
  config: string;
  packages: string;
  tokens: string;
}

export function resolveTablePrefix(config: S3Config): string {
  const prefix = config.postgres?.tablePrefix ?? DEFAULT_TABLE_PREFIX;
  if (prefix !== '' && !PREFIX_RE.test(prefix)) {
    throw new Error(
      `s3 storage: invalid postgres.tablePrefix '${prefix}'; must be empty (no prefix) or match ` +
        `${PREFIX_RE.source} (lower-case letters, digits and underscores; not starting with a digit)`
    );
  }
  return prefix;
}

export function resolveTables(config: S3Config): PostgresTables {
  const p = resolveTablePrefix(config);
  return {
    config: `${p}config`,
    packages: `${p}packages`,
    tokens: `${p}tokens`,
  };
}

export function buildSchemaDDL(tables: PostgresTables): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${tables.config} (`,
    '  key   text PRIMARY KEY,',
    '  value text NOT NULL',
    ');',
    `CREATE TABLE IF NOT EXISTS ${tables.packages} (`,
    '  name text PRIMARY KEY',
    ');',
    `CREATE TABLE IF NOT EXISTS ${tables.tokens} (`,
    '  username  text        NOT NULL,',
    '  key       text        NOT NULL,',
    '  token     text        NOT NULL,',
    "  cidr      text[]      NOT NULL DEFAULT '{}',",
    '  readonly  boolean     NOT NULL DEFAULT false,',
    '  created   timestamptz NOT NULL,',
    '  updated   timestamptz NOT NULL,',
    '  PRIMARY KEY (username, key)',
    ');',
  ].join('\n');
}
