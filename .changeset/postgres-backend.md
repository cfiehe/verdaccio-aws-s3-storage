---
'aws-s3-storage': minor
---

Add a Postgres registry-state backend and an explicit `database: bucket|dynamo|postgres` selector.

The registry index, secret, and tokens can now be stored in Postgres, enabling horizontally scaled deployments without DynamoDB (tarballs and package.json continue to live in S3). The new `database` config key selects the backend explicitly. Selecting the backend implicitly via `dynamoTableName` (`none` → bucket, otherwise dynamo) still works but now logs a deprecation warning and will be removed in a future major.

By default the Postgres backend creates its schema on startup (`postgres.autoCreateSchema`, default `true`). Set it to `false` to run with a DML-only role and pre-provision the tables from `db/schema.sql`. Table names are derived from `postgres.tablePrefix` (unset or empty → no prefix, i.e. bare `config`/`packages`/`tokens`; a non-empty value is validated against `^[a-z_][a-z0-9_]*$`); the runtime DDL and `db/schema.sql` share a single source of truth, and `pnpm schema:print` regenerates the file (pass `-- --prefix=<prefix>` for a custom one).
