import {describe, test, expect} from 'vitest';

import {
  DEFAULT_TABLE_PREFIX,
  buildSchemaDDL,
  resolveTablePrefix,
  resolveTables,
} from '../src/postgresSchema';
import type {S3Config} from '../types';

function cfg(tablePrefix?: string): S3Config {
  return {postgres: tablePrefix === undefined ? {} : {tablePrefix}} as unknown as S3Config;
}

describe('postgresSchema', () => {
  describe('resolveTablePrefix', () => {
    test('defaults to no prefix when unset', () => {
      expect(DEFAULT_TABLE_PREFIX).toBe('');
      expect(resolveTablePrefix(cfg())).toBe('');
    });

    test('treats an explicit empty string as no prefix', () => {
      expect(resolveTablePrefix(cfg(''))).toBe('');
    });

    test('accepts a valid lower-case prefix', () => {
      expect(resolveTablePrefix(cfg('npmreg_'))).toBe('npmreg_');
    });

    test.each(['Foo_', 'a-b', '1bad', 'foo;', 'drop table', 'foo bar'])(
      'rejects invalid non-empty prefix %j (SQL-injection boundary)',
      (bad) => {
        expect(() => resolveTablePrefix(cfg(bad))).toThrow('invalid postgres.tablePrefix');
      }
    );
  });

  describe('resolveTables', () => {
    test('derives the three table names from a prefix', () => {
      expect(resolveTables(cfg('npmreg_'))).toEqual({
        config: 'npmreg_config',
        packages: 'npmreg_packages',
        tokens: 'npmreg_tokens',
      });
    });

    test('uses bare table names when no prefix is set', () => {
      expect(resolveTables(cfg())).toEqual({
        config: 'config',
        packages: 'packages',
        tokens: 'tokens',
      });
    });
  });

  describe('buildSchemaDDL', () => {
    test('emits CREATE TABLE statements for the prefixed names', () => {
      const ddl = buildSchemaDDL(resolveTables(cfg('npmreg_')));
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS npmreg_config');
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS npmreg_packages');
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS npmreg_tokens');
    });

    test('emits bare table names when no prefix is set', () => {
      const ddl = buildSchemaDDL(resolveTables(cfg()));
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS config (');
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS packages (');
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS tokens (');
    });
  });
});
