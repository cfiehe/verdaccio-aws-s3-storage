import type {Pool, QueryResult, QueryResultRow} from 'pg';
import debugCore from 'debug';

import type {Callback, Logger, Token, TokenFilter} from '@verdaccio/types';

import type {S3Config} from '../types';
import type {S3DatabaseBackend} from './s3DatabaseBackend';
import {createPostgresPool} from './postgresClient';
import {buildSchemaDDL, resolveTables} from './postgresSchema';
import type {PostgresTables} from './postgresSchema';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:database:postgres');

const SECRET_KEY = 'secret';

/**
 * Normalize a Verdaccio token `created` value to a Date for the `timestamptz`
 * column. The field is typed `number | string`: epoch milliseconds (a number or
 * a numeric string) or an ISO date string. Reads convert the Date back to an ISO
 * string in readTokens.
 */
function toCreatedDate(created: number | string): Date {
  if (typeof created === 'number') {
    return new Date(created);
  }
  const epoch = Number(created);
  return Number.isNaN(epoch) ? new Date(created) : new Date(epoch);
}

/**
 * Registry-state backend backed by Postgres. Holds the index of hosted packages
 * (published or locally cached by this registry — not uplink-proxied packages),
 * the registry secret, and auth tokens. Every operation hits Postgres directly,
 * so all replicas read current state and writes are per-row atomic — safe for
 * horizontally scaled deployments. Package.json and tarballs are handled by
 * S3PackageManager, not here.
 *
 * Table names are derived from `postgres.tablePrefix` (unset or empty → no prefix,
 * i.e. the bare names config/packages/tokens) via the single source of truth in
 * postgresSchema.ts; a non-empty prefix is an identifier and cannot be a bound
 * parameter, so it is validated against a strict allowlist there before it is
 * interpolated into any statement.
 *
 * Schema handling: with `postgres.autoCreateSchema` (default true) the schema is
 * created once on first use, gated inside the single data-access primitive
 * `query()`. This is deliberately not tied to init(): Verdaccio 6.x never calls a
 * storage plugin's init(), so provisioning cannot rely on it. For a DML-only
 * runtime role, pre-provision the tables (generate the DDL for your prefix with
 * `pnpm schema:print -- --prefix=<prefix>`) and set `autoCreateSchema: false`;
 * query() is then a plain passthrough. (On PostgreSQL 15+ a CREATE TABLE IF NOT
 * EXISTS needs CREATE privilege even when the table already exists, so disabling
 * it is the only way to run without granting CREATE.)
 */
export default class S3DatabasePostgres implements S3DatabaseBackend {
  public logger: Logger;
  public config: S3Config;
  private pool: Pool;
  private readonly tables: PostgresTables;
  private readonly autoCreateSchema: boolean;
  private schemaReady?: Promise<void>;

  public constructor(config: S3Config, logger: Logger) {
    this.logger = logger;
    this.config = config;
    this.tables = resolveTables(config);
    this.autoCreateSchema = config.postgres?.autoCreateSchema !== false;
    this.pool = createPostgresPool(config);
  }

  /**
   * Single data-access primitive. When autoCreateSchema is enabled it ensures the
   * schema exists once (memoized) before the first statement runs; otherwise it is
   * a plain passthrough to the pool.
   */
  private async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: any[]
  ): Promise<QueryResult<R>> {
    if (this.autoCreateSchema) {
      if (!this.schemaReady) {
        debug('creating schema (first use)');
        this.logger.trace('aws-s3-storage: [postgres] creating schema');
        this.schemaReady = this.pool
          .query(buildSchemaDDL(this.tables))
          .then(() => undefined)
          .catch((err) => {
            this.schemaReady = undefined; // don't cache a failed attempt
            throw err;
          });
      }
      await this.schemaReady;
    }
    return this.pool.query<R>(text, params);
  }

  public async init(): Promise<void> {
    // Verdaccio 6.x never calls a storage plugin's init(); schema creation is gated
    // on the data path (query()). Where init() is called (7.x+) it acts as an early
    // connectivity check and eager provisioning.
    debug('init');
    if (!this.autoCreateSchema) {
      await this.pool.query('SELECT 1');
      return;
    }
    await this.query('SELECT 1');
  }

  public async getSecret(): Promise<string> {
    debug('getSecret');
    const result = await this.query<{value: string}>(
      `SELECT value FROM ${this.tables.config} WHERE key = $1`,
      [SECRET_KEY]
    );
    return result.rows[0]?.value ?? '';
  }

  public async setSecret(secret: string): Promise<void> {
    debug('setSecret');
    await this.query(
      `INSERT INTO ${this.tables.config} (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SECRET_KEY, secret]
    );
  }

  public add(name: string, callback: Callback): void {
    debug('add package=%o', name);
    this.query(
      `INSERT INTO ${this.tables.packages} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [name]
    ).then(
      () => callback(null),
      (err) => callback(err)
    );
  }

  public remove(name: string, callback: Callback): void {
    debug('remove package=%o', name);
    this.query(`DELETE FROM ${this.tables.packages} WHERE name = $1`, [name]).then(
      () => callback(null),
      (err) => callback(err)
    );
  }

  public get(callback: Callback): void {
    debug('get all packages');
    this.query<{name: string}>(`SELECT name FROM ${this.tables.packages} ORDER BY name`).then(
      (result) =>
        callback(
          null,
          result.rows.map((row) => row.name)
        ),
      (err) => callback(err)
    );
  }

  /**
   * Search packages. Verdaccio 6/7 calls this with callback pattern: search(onPackage, onEnd).
   * Newer versions may call with search(query): Promise<SearchItem[]>. Both are supported.
   */
  public search(...args: any[]): any {
    if (typeof args[0] === 'function') {
      const onPackage = args[0] as (item: any, cb: any) => void;
      const onEnd = args[1] as () => void;
      debug('search (callback): iterating packages from Postgres');
      this.query<{name: string}>(`SELECT name FROM ${this.tables.packages} ORDER BY name`).then(
        async (result) => {
          for (const row of result.rows) {
            await new Promise<void>((resolve): void => {
              onPackage({name: row.name, path: row.name, time: Date.now()}, resolve);
            });
          }
          onEnd();
        },
        (err) => {
          debug('search error: %o', err);
          onEnd();
        }
      );
      return;
    }

    debug('search (promise): returning empty results (delegated to uplinks)');
    return Promise.resolve([]);
  }

  public async saveToken(token: Token): Promise<void> {
    debug('saveToken user=%o key=%o', token.user, token.key);
    // A new token starts with updated = created. Re-saving an existing
    // (username, key) preserves created and bumps updated to now().
    await this.query(
      `INSERT INTO ${this.tables.tokens} (username, key, token, cidr, readonly, created, updated)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (username, key)
       DO UPDATE SET token = EXCLUDED.token, cidr = EXCLUDED.cidr,
                     readonly = EXCLUDED.readonly, updated = now()`,
      [
        token.user,
        token.key,
        token.token,
        token.cidr ?? [],
        token.readonly ?? false,
        toCreatedDate(token.created),
      ]
    );
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    debug('deleteToken user=%o key=%o', user, tokenKey);
    await this.query(`DELETE FROM ${this.tables.tokens} WHERE username = $1 AND key = $2`, [
      user,
      tokenKey,
    ]);
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    debug('readTokens user=%o', filter.user);
    const result = await this.query<{
      username: string;
      key: string;
      token: string;
      cidr: string[];
      readonly: boolean;
      created: Date;
      updated: Date;
    }>(
      `SELECT username, key, token, cidr, readonly, created, updated FROM ${this.tables.tokens} WHERE username = $1`,
      [filter.user]
    );
    return result.rows.map((row) => ({
      user: row.username,
      key: row.key,
      token: row.token,
      cidr: row.cidr,
      readonly: row.readonly,
      created: row.created.toISOString(),
      updated: row.updated.toISOString(),
    }));
  }
}
