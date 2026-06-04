import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { serve } from '@hono/node-server';
import { createVercelWorld } from '@workflow/world-vercel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkflowServer } from './create-app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('@workflow/workflow-server', () => {
  if (process.platform === 'win32') {
    it.skip('skipped on Windows', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let baseUrl: string;
  let stopServer: () => void;
  const token = 'test-server-token';

  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
    } catch (error) {
      console.warn('Docker not available, skipping integration tests:', error);
      return;
    }
    const dbUrl = container.getConnectionUri();
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    process.env.DATABASE_URL = dbUrl;

    const postgresPkg = path.resolve(__dirname, '../../world-postgres');
    execSync('pnpm build', { cwd: postgresPkg, stdio: 'pipe' });
    execSync('node bin/setup.js', {
      cwd: postgresPkg,
      env: process.env,
      stdio: 'pipe',
    });

    const { app } = createWorkflowServer({
      authTokens: [token],
      postgres: { connectionString: dbUrl },
      projectId: 'prj_test',
      deploymentKeyBase64: Buffer.alloc(32, 7).toString('base64'),
    });

    const server = serve({ fetch: app.fetch, port: 0 });
    const port =
      typeof server === 'object' && server && 'port' in server
        ? (server as { port: number }).port
        : 0;
    baseUrl = `http://127.0.0.1:${port}/api`;
    stopServer = () => server.close();

    process.env.WORKFLOW_VERCEL_BACKEND_URL = baseUrl;
  }, 180_000);

  afterAll(async () => {
    stopServer?.();
    await container?.stop();
  });

  it('health check', async (ctx) => {
    if (!container) ctx.skip();

    const res = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects missing auth', async (ctx) => {
    if (!container) ctx.skip();

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
  });

  it('creates a run via v2 events and reads it through world-vercel client', async (ctx) => {
    if (!container) ctx.skip();

    const world = createVercelWorld({
      token,
      projectConfig: {
        projectId: 'prj_test',
        teamId: 'team_test',
        environment: 'production',
      },
    });

    const result = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 2,
      eventData: {
        deploymentId: 'dpl_test_1',
        workflowName: 'testWorkflow',
        input: [1, 2, 3],
      },
    });

    expect(result.run?.runId).toMatch(/^wrun_/);
    expect(result.run?.status).toBe('pending');

    const fetched = await world.runs.get(result.run!.runId);
    expect(fetched.workflowName).toBe('testWorkflow');
  });

  it('returns run encryption key from meta endpoint', async (ctx) => {
    if (!container) ctx.skip();

    const res = await fetch(
      `http://127.0.0.1:${new URL(baseUrl).port}/v1/workflow/run-key/dpl_test?projectId=prj_test&runId=wrun_test123456789`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { key: string };
    expect(json.key).toBeTruthy();
  });
});
