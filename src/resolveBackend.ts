import type {Logger} from '@verdaccio/types';

import type {S3Config} from '../types';

export type DatabaseBackend = 'bucket' | 'dynamo' | 'postgres';

const BACKENDS: DatabaseBackend[] = ['bucket', 'dynamo', 'postgres'];

/**
 * Resolve which registry-state backend to use.
 *
 * Preferred: the explicit `database` config key. When it is unset, fall back to
 * the legacy selection via `dynamoTableName` (`none` → bucket, a table name →
 * dynamo, missing → error) and emit a deprecation warning. The legacy path is
 * kept for backward compatibility and will be removed in a future major.
 */
export default function resolveBackend(config: S3Config, logger: Logger): DatabaseBackend {
  if (config.database != null) {
    if (!BACKENDS.includes(config.database)) {
      throw new Error(
        `s3 storage: invalid database backend '${config.database}', expected one of: ${BACKENDS.join(', ')}`
      );
    }
    return config.database;
  }

  logger.warn(
    'aws-s3-storage: selecting the storage database implicitly via `dynamoTableName` is deprecated; ' +
      'set `database: bucket|dynamo|postgres` explicitly. The `dynamoTableName: none` sentinel will be removed in a future major.'
  );

  if (!config.dynamoTableName) {
    throw new Error('s3 storage requires a dynamoTableName (or set `database` explicitly)');
  }
  return config.dynamoTableName === 'none' ? 'bucket' : 'dynamo';
}
