# Scaling Verdaccio with the AWS S3 Storage Plugin

This guide explains how to run multiple Verdaccio instances behind a load balancer using the `verdaccio-aws-s3-storage` plugin.

## Why it scales

With a shared registry-state backend the plugin is **stateless** and any instance can serve any request. Every Verdaccio instance connects to the same shared backends:

- **S3** — stores package tarballs and metadata (`package.json`)
- **DynamoDB** _or_ **PostgreSQL** — stores the package list, registry secret, and auth tokens (selected via `database: dynamo|postgres`)

These backends read current state on every call, so nothing is cached in memory or written to local disk. The **bucket** backend (`database: bucket`) is the exception: it caches state in memory and is single-instance only, so it cannot be used in a scaled deployment.

```
                    ┌──────────────┐
                    │ Load Balancer │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴─────┐ ┌───┴─────┐
        │ Verdaccio  │ │Verdaccio│ │Verdaccio│
        │  node 1    │ │ node 2  │ │ node N  │
        └─────┬─────┘ └───┬─────┘ └───┴─────┘
              │            │            │
              └────────────┼────────────┘
                     ┌─────┴─────┐
                     │           │
                ┌────┴───┐  ┌───┴────┐
                │   S3   │  │DynamoDB│
                │(blobs) │  │ (state)│
                └────────┘  └────────┘
```

_(The state store is DynamoDB or PostgreSQL, depending on `database`.)_

## Concurrency safety

| Operation                      | Backend                           | Concurrency behavior                                                                                           |
| ------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `createPackage`                | S3 `HeadObject` → `PutObject`     | Two simultaneous publishes of the same version: one succeeds, the other gets a 409 conflict. Correct behavior. |
| `add` / `remove`               | DynamoDB `PutItem` / `DeleteItem` | Atomic single-item writes. No race conditions.                                                                 |
| `getSecret`                    | DynamoDB `GetItem`                | First node to start generates the secret and stores it. All subsequent reads return the same value.            |
| `saveToken` / `readTokens`     | DynamoDB `PutItem` / `Query`      | Tokens are stored per-user with a unique key. Any node can authenticate any user.                              |
| `readTarball` / `writeTarball` | S3 `GetObject` / multipart upload | S3 handles concurrent access natively.                                                                         |

The table shows the DynamoDB backend. The **postgres** backend gives the same guarantees: `add` / `remove` / `saveToken` / `deleteToken` are single-row `INSERT ... ON CONFLICT` / `DELETE` statements (atomic), `getSecret` upserts on first use, and every read reflects committed state.

One caveat applies to **all** backends: `savePackage` performs a read-modify-write on the package manifest, so two concurrent publishes touching the same package can race on the manifest. If your workflow allows truly concurrent publishes of the same package, serialize them upstream — e.g. a GitLab CI `resource_group`, or routing publishes through a single path.

## Infrastructure requirements

### S3

- One bucket shared by all instances
- Default request limits: 5,500 GET/s and 3,500 PUT/s per prefix
- For high-traffic registries, spread packages across multiple `keyPrefix` values or enable S3 request rate optimization

### DynamoDB

- One table shared by all instances
- **PAY_PER_REQUEST** billing mode is recommended — it auto-scales with traffic and requires no capacity planning
- For predictable workloads with cost optimization needs, switch to **provisioned** mode with auto-scaling enabled

### Postgres

- One database shared by all instances (`database: postgres`)
- A small connection pool per instance is plenty; tune `postgres.pool.max` against your server's `max_connections` divided by the number of replicas
- Schema: with `autoCreateSchema: true` (default) the role needs CREATE on the target schema for the first-run DDL; for a least-privilege DML-only role, pre-provision [`db/schema.sql`](../db/schema.sql) and set `autoCreateSchema: false`
- Use a connection pooler (PgBouncer, or a managed equivalent) if the replica count is high enough to pressure `max_connections`

### Load balancer

- Health check: `GET /-/ping` on port 4873 (returns `{}` with 200 OK)
- Session stickiness: **not required** — the plugin is stateless
- Protocol: HTTP is sufficient; terminate TLS at the load balancer

### Authentication

The default `htpasswd` auth stores user credentials in a local file (`/verdaccio/storage/htpasswd`). This does **not** scale across multiple instances because each node has its own filesystem.

Options for multi-node auth:

1. **Shared filesystem** — mount a shared `htpasswd` file via EFS (AWS), NFS, or a PersistentVolume (Kubernetes)
2. **External auth plugin** — use an auth plugin that delegates to an external system (LDAP, OAuth2, GitHub, etc.)
3. **Pre-seeded htpasswd** — bake a static `htpasswd` file into the Docker image (suitable for CI/internal registries where users don't self-register)

## IAM credentials

For multi-node deployments, **do not** hardcode `accessKeyId` / `secretAccessKey` in the config. Instead:

- **ECS/Fargate**: assign an IAM task role to the task definition
- **EKS**: use [IAM Roles for Service Accounts (IRSA)](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html) or [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- **EC2**: use an instance profile

The AWS SDK v3 credential chain picks these up automatically when `accessKeyId` is not set in the plugin config.

## Deployment examples

### ECS / Fargate

```json
{
  "family": "verdaccio",
  "taskRoleArn": "arn:aws:iam::123456789012:role/verdaccio-task-role",
  "networkMode": "awsvpc",
  "containerDefinitions": [
    {
      "name": "verdaccio",
      "image": "your-ecr-repo/verdaccio-aws-s3-storage:latest",
      "portMappings": [
        {
          "containerPort": 4873,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {"name": "AWS_S3_BUCKET", "value": "verdaccio-storage"},
        {"name": "AWS_S3_KEY_PREFIX", "value": "packages"},
        {"name": "AWS_DEFAULT_REGION", "value": "us-east-1"},
        {"name": "AWS_DYNAMO_TABLE_NAME", "value": "verdaccio-registry"},
        {"name": "DEBUG", "value": "verdaccio:plugin*"}
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -sf http://localhost:4873/-/ping || exit 1"],
        "interval": 15,
        "timeout": 5,
        "retries": 3
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/verdaccio",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "verdaccio"
        }
      }
    }
  ],
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024"
}
```

Create a service with desired count >= 2 and an ALB target group pointing to port 4873.

### Kubernetes

See [`examples/helm/`](../examples/helm/) for a complete Helm values file using the official [verdaccio Helm chart](https://github.com/verdaccio/charts).

### Docker Compose (multi-replica)

```yaml
services:
  verdaccio:
    build: .
    deploy:
      replicas: 3
    environment:
      - AWS_S3_BUCKET=verdaccio-storage
      - AWS_S3_KEY_PREFIX=packages
      - AWS_DEFAULT_REGION=us-east-1
      - AWS_DYNAMO_TABLE_NAME=verdaccio-registry
      - AWS_DYNAMO_ENDPOINT=http://localstack:4566
      - AWS_S3_ENDPOINT=http://localstack:4566
      - AWS_ACCESS_KEY_ID=test
      - AWS_SECRET_ACCESS_KEY=test
    ports:
      - '4873-4875:4873'
```

## Operational considerations

### Monitoring

Key metrics to watch:

- **S3**: `GetObject` / `PutObject` latency and error rates (via CloudWatch S3 metrics)
- **DynamoDB**: `ConsumedReadCapacityUnits`, `ConsumedWriteCapacityUnits`, `ThrottledRequests` (via CloudWatch DynamoDB metrics)
- **Verdaccio**: response times and error rates at the load balancer level
- **Debug logs**: enable `DEBUG=verdaccio:plugin*` to see all plugin operations

### Disaster recovery

- **S3**: enable versioning on the bucket for point-in-time recovery of package data
- **DynamoDB**: enable point-in-time recovery (PITR) for the table
- **Postgres**: rely on your server's backup story — PITR via WAL archiving, scheduled `pg_dump`, or managed automated backups/snapshots
- **Backups**: DynamoDB on-demand backups can be triggered via AWS CLI or scheduled via AWS Backup
