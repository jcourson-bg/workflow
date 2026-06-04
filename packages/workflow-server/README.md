# @workflow/workflow-server

Self-hosted [**workflow-server**](https://vercel.com/docs/workflow) compatible HTTP API for [Workflow DevKit](https://github.com/vercel/workflow).

Implements the storage, streaming, and metadata endpoints consumed by `@workflow/world-vercel`, backed by:

- **PostgreSQL** via `@workflow/world-postgres` (event log + materialized entities)
- **Optional Vercel Blob** for large payload refs (`s3rf:`)
- **Pluggable Bearer auth** (your tokens — no Vercel OIDC required)

Queue execution still uses **@vercel/queue** (VQS) or `@workflow/world-postgres` workers — this package is the **control plane / storage API**.

## Quick start

```bash
# 1. Database
export WORKFLOW_POSTGRES_URL="postgres://world:world@localhost:5432/world"
pnpm exec workflow-postgres-setup

# 2. Auth token (required in production)
export WORKFLOW_SERVER_AUTH_TOKEN="your-secret-token"

# 3. Start API server (default :3001)
pnpm --filter @workflow/workflow-server exec workflow-server
```

Point your workflow app at the server:

```bash
export WORKFLOW_TARGET_WORLD=vercel
export WORKFLOW_VERCEL_BACKEND_URL="http://localhost:3001/api"
export WORKFLOW_VERCEL_AUTH_TOKEN="your-secret-token"
export WORKFLOW_VERCEL_PROJECT="my-project"
export WORKFLOW_VERCEL_TEAM="my-team"
```

Or programmatically:

```typescript
import { createVercelWorld } from '@workflow/world-vercel';
import { setWorld } from '@workflow/core/runtime';

setWorld(
  createVercelWorld({
    token: process.env.WORKFLOW_VERCEL_AUTH_TOKEN,
    projectConfig: {
      projectId: 'my-project',
      teamId: 'my-team',
      environment: 'production',
    },
  })
);
```

Set `WORKFLOW_SERVER_URL_OVERRIDE` in `world-vercel` utils (dev) or use the proxy URL above.

## Custom auth

```typescript
import { createWorkflowServer } from '@workflow/workflow-server';

const { app } = createWorkflowServer({
  auth: async (request) => {
    const apiKey = request.headers.get('x-api-key');
    if (apiKey === process.env.MY_API_KEY) return { ok: true };
    return { ok: false, status: 401, message: 'Unauthorized' };
  },
});
```

## API surface

| Area | Paths |
|------|--------|
| Runs | `GET/POST /api/v2/runs`, `GET /api/v2/runs/:id` |
| Events | `POST /api/v2/runs/:runId/events`, `GET` list/get |
| Steps | `GET/POST/PUT /api/v2/runs/:runId/steps` |
| Hooks | `GET/POST/DELETE /api/v2/hooks/*` |
| Streams | `PUT/GET /api/v2/runs/:runId/stream/:name` |
| Refs | `GET /api/v2/runs/:runId/refs?ref=` |
| v1 compat | `/api/v1/runs/create`, cancel, events |
| Encryption | `GET /v1/workflow/run-key/:deploymentId` |

All storage endpoints support **CBOR** (`Content-Type: application/cbor`) and `remoteRefBehavior=lazy|resolve`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `WORKFLOW_POSTGRES_URL` | PostgreSQL connection string |
| `WORKFLOW_SERVER_AUTH_TOKEN` | Bearer token(s) for API auth |
| `BLOB_READ_WRITE_TOKEN` | Enable Vercel Blob for large refs |
| `WORKFLOW_DEPLOYMENT_KEY` | Base64 key for per-run encryption API |
| `WORKFLOW_SERVER_PROJECT_ID` | HKDF project context for encryption |
| `WORKFLOW_SERVER_REF_DIR` | Filesystem ref fallback when Blob unset |
| `PORT` | HTTP port (default `3001`) |

## Deployment on Vercel

Deploy as a standalone Hono/Node serverless app or long-running service. Use **Vercel Postgres**, **Blob**, and wire `WORKFLOW_VERCEL_BACKEND_URL` to your deployment URL + `/api`.

For production workflow **execution**, also deploy your Next.js workflow app with VQS consumers on `/.well-known/workflow/v1/*`.
