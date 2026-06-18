import {Pool} from 'pg';
import type {PoolConfig} from 'pg';
import debugCore from 'debug';

import type {S3Config} from '../types';
import setConfigValue from './setConfigValue';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:postgres-client');

/**
 * Create a Postgres connection pool from the `postgres` config block. `postgres.pool`
 * is passed through to node-postgres verbatim; `postgres.url` (a libpq connection
 * string, env-substituted) is then applied as `connectionString`, overriding any
 * connection fields in `pool`. With neither set, node-postgres falls back to the
 * standard PG* environment variables.
 */
export function createPostgresPool(config: S3Config): Pool {
  const pg = config.postgres ?? {};
  const poolConfig: PoolConfig = {...(pg.pool as PoolConfig | undefined)};

  const url = setConfigValue(pg.url);
  if (url) {
    poolConfig.connectionString = url;
  }

  debug(
    'creating Postgres pool max=%o connectionTimeoutMillis=%o',
    poolConfig.max,
    poolConfig.connectionTimeoutMillis
  );

  const pool = new Pool(poolConfig);
  pool.on('error', (err) => {
    debug('idle client error: %o', err.message);
  });
  return pool;
}
