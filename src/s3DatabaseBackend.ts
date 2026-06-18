import type {Callback, Token, TokenFilter} from '@verdaccio/types';

/**
 * Contract for the registry-state backend used by S3Database: the index of
 * hosted package names, the registry secret, and auth tokens. Per-package
 * package.json and tarballs are NOT part of this contract; they are handled by
 * S3PackageManager against S3.
 *
 * Implementations: S3DatabaseBucket (single JSON object in S3),
 * S3DatabaseDynamo (DynamoDB), S3DatabasePostgres (Postgres). The bucket store
 * caches state in memory and is single-instance only; Dynamo and Postgres read
 * current state on every call and are safe for horizontally scaled deployments.
 */
export interface S3DatabaseBackend {
  init(): Promise<void>;

  getSecret(): Promise<string>;
  setSecret(secret: string): Promise<void>;

  add(name: string, callback: Callback): void;
  remove(name: string, callback: Callback): void;
  get(callback: Callback): void;
  search(...args: any[]): any;

  saveToken(token: Token): Promise<void>;
  deleteToken(user: string, tokenKey: string): Promise<void>;
  readTokens(filter: TokenFilter): Promise<Token[]>;
}
