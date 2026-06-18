import {describe, test, expect, vi, beforeEach} from 'vitest';
import type {Logger, Config} from '@verdaccio/types';

import S3Database from '../src/s3Database';

const logger: Logger = {
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn(),
  http: vi.fn(),
  trace: vi.fn(),
} as any;

let pgQuerySpy: ReturnType<typeof vi.fn>;

vi.mock('../src/postgresClient', () => ({
  createPostgresPool: vi.fn(() => ({
    query: (...args: any[]) => (pgQuerySpy as (...args: any[]) => any)(...args),
    on: () => undefined,
  })),
}));

vi.mock('../src/s3Client', () => ({
  createS3Client: vi.fn(() => ({})),
}));

function makeDbConfig() {
  return {
    store: {
      'aws-s3-storage': {
        bucket: 'test-bucket',
        keyPrefix: 'prefix',
        region: 'us-east-1',
        database: 'postgres',
        // false so ensureSchema() is a no-op and the operation under test is call[0]
        postgres: {url: 'postgres://localhost/verdaccio', autoCreateSchema: false},
      },
    },
  } as unknown as Config;
}

function createDb(): S3Database {
  return new S3Database(makeDbConfig(), {logger, config: makeDbConfig()});
}

function cbToPromise<T = any>(fn: (cb: (...args: any[]) => void) => void): Promise<T[]> {
  return new Promise((resolve) => {
    fn((...args: any[]) => resolve(args));
  });
}

describe('S3Database (postgres backend)', () => {
  beforeEach(() => {
    pgQuerySpy = vi.fn().mockResolvedValue({rows: []});
  });

  describe('constructor', () => {
    test('creates instance with valid config - postgres (no dynamoTableName needed)', () => {
      const db = createDb();
      expect(db).toBeDefined();
      expect(db.config.bucket).toBe('test-bucket');
    });

    test('throws on unknown database backend', () => {
      const config = {
        store: {'aws-s3-storage': {bucket: 'b', database: 'redis'}},
      } as unknown as Config;
      expect(() => new S3Database(config, {logger, config})).toThrow('invalid database backend');
    });
  });

  describe('schema management', () => {
    function makeAutoCreateConfig() {
      return {
        store: {
          'aws-s3-storage': {
            bucket: 'test-bucket',
            keyPrefix: 'prefix',
            database: 'postgres',
            postgres: {url: 'postgres://localhost/verdaccio'}, // autoCreateSchema default true
          },
        },
      } as unknown as Config;
    }

    test('init creates the schema when autoCreateSchema is enabled (default)', async () => {
      const db = new S3Database(makeAutoCreateConfig(), {logger, config: makeAutoCreateConfig()});
      await db.init();
      const sql = pgQuerySpy.mock.calls[0][0] as string;
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS config');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS packages');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS tokens');
    });

    test('creates the schema lazily before the first operation when init() is not called', async () => {
      // Regression: the host may call getSecret() before init(); the schema must
      // still be ensured so the query does not hit a missing relation.
      pgQuerySpy.mockResolvedValueOnce({rows: []}); // CREATE TABLE
      pgQuerySpy.mockResolvedValueOnce({rows: []}); // SELECT value
      const db = new S3Database(makeAutoCreateConfig(), {logger, config: makeAutoCreateConfig()});
      const secret = await db.getSecret(); // no init() first
      expect(pgQuerySpy.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS config');
      expect(pgQuerySpy.mock.calls[1][0]).toContain('SELECT value FROM config');
      expect(secret).toBe('');
    });

    test('ensures the schema only once across multiple operations', async () => {
      const db = new S3Database(makeAutoCreateConfig(), {logger, config: makeAutoCreateConfig()});
      await db.getSecret();
      await db.setSecret('s');
      await db.readTokens({user: 'a'} as any);
      const ddlCalls = pgQuerySpy.mock.calls.filter((c) =>
        String(c[0]).includes('CREATE TABLE IF NOT EXISTS')
      );
      expect(ddlCalls).toHaveLength(1);
    });

    test('init skips DDL and only probes connectivity when autoCreateSchema is false', async () => {
      const db = createDb(); // makeDbConfig has autoCreateSchema: false
      await db.init();
      expect(pgQuerySpy).toHaveBeenCalledTimes(1);
      expect(pgQuerySpy.mock.calls[0][0]).toBe('SELECT 1');
    });
  });

  describe('getSecret', () => {
    test('returns secret from Postgres', async () => {
      pgQuerySpy.mockResolvedValue({rows: [{value: 'my-secret'}]});
      const db = createDb();
      expect(await db.getSecret()).toBe('my-secret');
      const [sql, params] = pgQuerySpy.mock.calls[0];
      expect(sql).toContain('SELECT value FROM config');
      expect(params).toEqual(['secret']);
    });

    test('returns empty string when no secret row exists', async () => {
      pgQuerySpy.mockResolvedValue({rows: []});
      const db = createDb();
      expect(await db.getSecret()).toBe('');
    });
  });

  describe('setSecret', () => {
    test('upserts secret', async () => {
      const db = createDb();
      await db.setSecret('new-secret');
      const [sql, params] = pgQuerySpy.mock.calls[0];
      expect(sql).toContain('INSERT INTO config');
      expect(sql).toContain('ON CONFLICT');
      expect(params).toEqual(['secret', 'new-secret']);
    });
  });

  describe('add', () => {
    test('inserts package idempotently', async () => {
      const db = createDb();
      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect(err).toBeNull();
      const [sql, params] = pgQuerySpy.mock.calls[0];
      expect(sql).toContain('INSERT INTO packages');
      expect(sql).toContain('ON CONFLICT (name) DO NOTHING');
      expect(params).toEqual(['jquery']);
    });

    test('forwards postgres errors', async () => {
      pgQuerySpy.mockRejectedValue(new Error('write failed'));
      const db = createDb();
      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect((err as any)?.message).toBe('write failed');
    });
  });

  describe('get', () => {
    test('returns ordered package names', async () => {
      pgQuerySpy.mockResolvedValue({rows: [{name: 'a'}, {name: 'b'}]});
      const db = createDb();
      const [err, list] = await cbToPromise((cb) => db.get(cb));
      expect(err).toBeNull();
      expect(list).toEqual(['a', 'b']);
    });
  });

  describe('tokens', () => {
    test('saveToken upserts the token into discrete columns', async () => {
      const db = createDb();
      const created = '2026-01-30T08:21:43.827Z';
      const token = {
        user: 'alice',
        key: 'k1',
        token: 'tok',
        cidr: ['10.0.0.0/8'],
        readonly: false,
        created,
      };
      await db.saveToken(token as any);
      const [sql, params] = pgQuerySpy.mock.calls[0];
      expect(sql).toContain('INSERT INTO tokens');
      expect(sql).toContain('(username, key, token, cidr, readonly, created, updated)');
      expect(sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $6)');
      expect(sql).toContain('updated = now()');
      expect(sql).not.toContain('created = EXCLUDED.created');
      expect(params[0]).toBe('alice');
      expect(params[1]).toBe('k1');
      expect(params[2]).toBe('tok');
      expect(params[3]).toEqual(['10.0.0.0/8']);
      expect(params[4]).toBe(false);
      expect(params[5]).toBeInstanceOf(Date);
      expect((params[5] as Date).toISOString()).toBe(created);
    });

    test('saveToken defaults cidr to [] and accepts epoch-number created', async () => {
      const db = createDb();
      await db.saveToken({
        user: 'bob',
        key: 'k2',
        token: 't',
        readonly: true,
        created: 1769761303827,
      } as any);
      const [, params] = pgQuerySpy.mock.calls[0];
      expect(params[3]).toEqual([]);
      expect(params[4]).toBe(true);
      expect(params[5]).toBeInstanceOf(Date);
      expect((params[5] as Date).getTime()).toBe(1769761303827);
    });

    test('readTokens maps columns back to token objects', async () => {
      pgQuerySpy.mockResolvedValue({
        rows: [
          {
            username: 'alice',
            key: 'k1',
            token: 'tok',
            cidr: ['10.0.0.0/8'],
            readonly: false,
            created: new Date('2026-01-30T08:21:43.827Z'),
            updated: new Date('2026-02-01T10:00:00.000Z'),
          },
        ],
      });
      const db = createDb();
      const tokens = await db.readTokens({user: 'alice'} as any);
      expect(tokens).toEqual([
        {
          user: 'alice',
          key: 'k1',
          token: 'tok',
          cidr: ['10.0.0.0/8'],
          readonly: false,
          created: '2026-01-30T08:21:43.827Z',
          updated: '2026-02-01T10:00:00.000Z',
        },
      ]);
    });

    test('deleteToken removes by user and key', async () => {
      const db = createDb();
      await db.deleteToken('alice', 'k1');
      const [sql, params] = pgQuerySpy.mock.calls[0];
      expect(sql).toContain('DELETE FROM tokens');
      expect(params).toEqual(['alice', 'k1']);
    });
  });

  describe('tablePrefix', () => {
    function makePrefixedConfig() {
      return {
        store: {
          'aws-s3-storage': {
            bucket: 'test-bucket',
            keyPrefix: 'prefix',
            database: 'postgres',
            postgres: {
              url: 'postgres://localhost/verdaccio',
              autoCreateSchema: false,
              tablePrefix: 'npmreg_',
            },
          },
        },
      } as unknown as Config;
    }

    function createPrefixedDb(): S3Database {
      return new S3Database(makePrefixedConfig(), {logger, config: makePrefixedConfig()});
    }

    test('DML targets the prefixed tables', async () => {
      const db = createPrefixedDb();
      await db.getSecret();
      expect(pgQuerySpy.mock.calls[0][0]).toContain('FROM npmreg_config');
    });

    test('schema DDL uses the prefixed table names', async () => {
      const config = {
        store: {
          'aws-s3-storage': {
            bucket: 'test-bucket',
            keyPrefix: 'prefix',
            database: 'postgres',
            postgres: {url: 'postgres://localhost/verdaccio', tablePrefix: 'npmreg_'},
          },
        },
      } as unknown as Config;
      const db = new S3Database(config, {logger, config});
      await db.init();
      const sql = pgQuerySpy.mock.calls[0][0] as string;
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS npmreg_config');
      expect(sql).not.toContain('verdaccio_');
    });

    test('an invalid prefix is rejected at construction (SQLi boundary)', () => {
      const config = {
        store: {
          'aws-s3-storage': {
            bucket: 'b',
            database: 'postgres',
            postgres: {tablePrefix: 'foo; drop table x'},
          },
        },
      } as unknown as Config;
      expect(() => new S3Database(config, {logger, config})).toThrow(
        'invalid postgres.tablePrefix'
      );
    });
  });
});
