import {describe, test, expect, vi, beforeEach} from 'vitest';
import type {Logger} from '@verdaccio/types';

import resolveBackend from '../src/resolveBackend';
import type {S3Config} from '../types';

const logger: Logger = {
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn(),
  http: vi.fn(),
  trace: vi.fn(),
} as any;

function cfg(over: Partial<S3Config>): S3Config {
  return {bucket: 'b', keyPrefix: '', ...over} as S3Config;
}

describe('resolveBackend', () => {
  beforeEach(() => {
    (logger.warn as any).mockClear();
  });

  describe('explicit database key (no deprecation)', () => {
    test.each(['bucket', 'dynamo', 'postgres'] as const)('returns %s', (backend) => {
      expect(resolveBackend(cfg({database: backend}), logger)).toBe(backend);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('throws on unknown value', () => {
      expect(() => resolveBackend(cfg({database: 'redis' as any}), logger)).toThrow(
        'invalid database backend'
      );
    });
  });

  describe('legacy dynamoTableName selection (deprecated)', () => {
    test('none maps to bucket and warns', () => {
      expect(resolveBackend(cfg({dynamoTableName: 'none'}), logger)).toBe('bucket');
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    test('a table name maps to dynamo and warns', () => {
      expect(resolveBackend(cfg({dynamoTableName: 'my-table'}), logger)).toBe('dynamo');
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    test('throws when neither database nor dynamoTableName is set', () => {
      expect(() => resolveBackend(cfg({}), logger)).toThrow('requires a dynamoTableName');
    });
  });
});
