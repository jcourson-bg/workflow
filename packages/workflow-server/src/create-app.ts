import { WorkflowAPIError, WorkflowRunNotFoundError } from '@workflow/errors';
import {
  CreateEventSchema,
  SPEC_VERSION_CURRENT,
  type AnyEventRequest,
  type CreateEventParams,
  type EventResult,
  type WorkflowRun,
} from '@workflow/world';
import { deriveRunKey } from '@workflow/world-vercel';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthVerifier, WorkflowServerConfig } from './config.js';
import { readRequestBuffer, parseRequestBody } from './cbor.js';
import { resolveAuthVerifier } from './auth.js';
import { createContext, type WorkflowServerContext } from './context.js';
import { errorResponse, jsonOrCbor } from './response.js';
import { decodeMultiChunks } from './streams.js';
import {
  parseRemoteRefBehavior,
  wireEvent,
  wireHook,
  wireRun,
  wireStep,
} from './wire.js';

export interface WorkflowServer {
  app: Hono;
  context: WorkflowServerContext;
  close(): Promise<void>;
}

async function createEvent(
  world: WorkflowServerContext['world'],
  runId: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams
): Promise<EventResult> {
  return (
    world.events as { create: (...args: unknown[]) => Promise<EventResult> }
  ).create(runId, data, params);
}

const authMiddleware = (verify: AuthVerifier) =>
  createMiddleware(async (c, next) => {
    const result = await verify(c.req.raw);
    if (!result.ok) {
      return errorResponse(
        c.req.raw,
        new WorkflowAPIError(result.message, {
          status: result.status,
        })
      );
    }
    await next();
  });

export function createWorkflowServer(
  userConfig: WorkflowServerConfig = {}
): WorkflowServer {
  const context = createContext(userConfig);
  const { world, refStore, config } = context;
  const verify = resolveAuthVerifier(config);

  const api = new Hono();

  api.use('*', authMiddleware(verify));

  api.get('/health', (c) => c.json({ status: 'ok' }));

  // ---------------------------------------------------------------------------
  // v2 Runs
  // ---------------------------------------------------------------------------
  api.get('/v2/runs', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const limit = Number(c.req.query('limit') || '100');
      const cursor = c.req.query('cursor') || undefined;
      const sortOrder = (c.req.query('sortOrder') as 'asc' | 'desc') || 'desc';
      const resolveData = behavior === 'lazy' ? 'none' : 'all';

      const response = await world.runs.list({
        pagination: { limit, cursor, sortOrder },
        resolveData,
      });

      const data = await Promise.all(
        response.data.map((run) =>
          wireRun(run as WorkflowRun, refStore, behavior)
        )
      );

      return jsonOrCbor(c.req.raw, { ...response, data });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/runs/:runId', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const run = await world.runs.get(c.req.param('runId'), { resolveData });
      return jsonOrCbor(
        c.req.raw,
        await wireRun(run as WorkflowRun, refStore, behavior)
      );
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  // ---------------------------------------------------------------------------
  // v2 Events
  // ---------------------------------------------------------------------------
  api.post('/v2/runs/:runId/events', async (c) => {
    try {
      const raw = await readRequestBuffer(c.req.raw);
      const body = parseRequestBody(c.req.raw, raw) as AnyEventRequest & {
        remoteRefBehavior?: 'lazy' | 'resolve';
      };
      const runIdParam = c.req.param('runId');
      const runId = runIdParam === 'null' ? null : runIdParam;

      const params: CreateEventParams = {
        resolveData: 'all',
        v1Compat: false,
      };

      const result = await createEvent(world, runId, body, params);
      const behavior = body.remoteRefBehavior ?? 'resolve';

      const wireResult: Record<string, unknown> = {
        event: result.event
          ? await wireEvent(result.event, refStore, behavior)
          : undefined,
        run: result.run
          ? await wireRun(result.run, refStore, behavior)
          : undefined,
        step: result.step
          ? await wireStep(result.step, refStore, behavior)
          : undefined,
        hook: result.hook
          ? await wireHook(result.hook, refStore, behavior)
          : undefined,
      };

      return jsonOrCbor(c.req.raw, wireResult);
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/runs/:runId/events/:eventId', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const event = await world.events.get(
        c.req.param('runId'),
        c.req.param('eventId'),
        { resolveData }
      );
      return jsonOrCbor(c.req.raw, await wireEvent(event, refStore, behavior));
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/runs/:runId/events', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const limit = Number(c.req.query('limit') || '100');
      const cursor = c.req.query('cursor') || undefined;
      const sortOrder = (c.req.query('sortOrder') as 'asc' | 'desc') || 'asc';

      const response = await world.events.list({
        runId: c.req.param('runId'),
        pagination: { limit, cursor, sortOrder },
        resolveData,
      });

      const data = await Promise.all(
        response.data.map((e) => wireEvent(e, refStore, behavior))
      );
      return jsonOrCbor(c.req.raw, { ...response, data });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/events', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const correlationId = c.req.query('correlationId');
      if (!correlationId) {
        throw new WorkflowAPIError('correlationId is required', {
          status: 400,
        });
      }
      const limit = Number(c.req.query('limit') || '100');
      const cursor = c.req.query('cursor') || undefined;
      const sortOrder = (c.req.query('sortOrder') as 'asc' | 'desc') || 'asc';

      const response = await world.events.listByCorrelationId({
        correlationId,
        pagination: { limit, cursor, sortOrder },
        resolveData,
      });

      const data = await Promise.all(
        response.data.map((e) => wireEvent(e, refStore, behavior))
      );
      return jsonOrCbor(c.req.raw, { ...response, data });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  // ---------------------------------------------------------------------------
  // v2 Steps
  // ---------------------------------------------------------------------------
  api.get('/v2/runs/:runId/steps', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const limit = Number(c.req.query('limit') || '100');
      const cursor = c.req.query('cursor') || undefined;
      const sortOrder = (c.req.query('sortOrder') as 'asc' | 'desc') || 'asc';

      const response = await world.steps.list({
        runId: c.req.param('runId'),
        pagination: { limit, cursor, sortOrder },
        resolveData,
      });

      const data = await Promise.all(
        response.data.map((s) => wireStep(s, refStore, behavior))
      );
      return jsonOrCbor(c.req.raw, { ...response, data });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/runs/:runId/steps/:stepId', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const step = await world.steps.get(
        c.req.param('runId'),
        c.req.param('stepId'),
        { resolveData }
      );
      return jsonOrCbor(c.req.raw, await wireStep(step, refStore, behavior));
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/steps/:stepId', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const step = await world.steps.get(undefined, c.req.param('stepId'), {
        resolveData,
      });
      return jsonOrCbor(c.req.raw, await wireStep(step, refStore, behavior));
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.post('/v2/runs/:runId/steps', async (c) => {
    try {
      const raw = await readRequestBuffer(c.req.raw);
      const body = parseRequestBody(c.req.raw, raw) as {
        stepId: string;
        stepName: string;
        input: unknown;
      };
      const result = await createEvent(
        world,
        c.req.param('runId'),
        {
          eventType: 'step_created',
          correlationId: body.stepId,
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { stepName: body.stepName, input: body.input },
        },
        { resolveData: 'all' }
      );
      if (!result.step) {
        throw new WorkflowAPIError('Step was not created', { status: 500 });
      }
      return jsonOrCbor(
        c.req.raw,
        await wireStep(result.step, refStore, 'resolve')
      );
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.put('/v2/runs/:runId/steps/:stepId', async (c) => {
    try {
      const raw = await readRequestBuffer(c.req.raw);
      const body = parseRequestBody(c.req.raw, raw) as {
        status?: string;
        output?: unknown;
        error?: unknown;
        attempt?: number;
        retryAfter?: string;
      };
      const runId = c.req.param('runId');
      const stepId = c.req.param('stepId');

      if (body.status === 'completed' && body.output !== undefined) {
        const result = await createEvent(world, runId, {
          eventType: 'step_completed',
          correlationId: stepId,
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { result: body.output },
        });
        return jsonOrCbor(
          c.req.raw,
          result.step ? await wireStep(result.step, refStore, 'resolve') : {}
        );
      }

      if (body.status === 'failed' && body.error !== undefined) {
        const result = await createEvent(world, runId, {
          eventType: 'step_failed',
          correlationId: stepId,
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { error: body.error },
        });
        return jsonOrCbor(
          c.req.raw,
          result.step ? await wireStep(result.step, refStore, 'resolve') : {}
        );
      }

      if (body.status === 'running') {
        const result = await createEvent(world, runId, {
          eventType: 'step_started',
          correlationId: stepId,
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { attempt: body.attempt },
        });
        return jsonOrCbor(
          c.req.raw,
          result.step ? await wireStep(result.step, refStore, 'resolve') : {}
        );
      }

      throw new WorkflowAPIError('Unsupported step update', { status: 400 });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  // ---------------------------------------------------------------------------
  // v2 Hooks
  // ---------------------------------------------------------------------------
  api.get('/v2/hooks', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const runId = c.req.query('runId') || undefined;
      const limit = Number(c.req.query('limit') || '100');
      const cursor = c.req.query('cursor') || undefined;
      const sortOrder = (c.req.query('sortOrder') as 'asc' | 'desc') || 'asc';

      const response = await world.hooks.list({
        runId,
        pagination: { limit, cursor, sortOrder },
        resolveData,
      });

      const data = await Promise.all(
        response.data.map((h) => wireHook(h, refStore, behavior))
      );
      return jsonOrCbor(c.req.raw, { ...response, data });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/hooks/:hookId', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const hook = await world.hooks.get(c.req.param('hookId'), {
        resolveData,
      });
      return jsonOrCbor(c.req.raw, await wireHook(hook, refStore, behavior));
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/hooks/by-token', async (c) => {
    try {
      const token = c.req.query('token');
      if (!token) {
        throw new WorkflowAPIError('token is required', { status: 400 });
      }
      const hook = await world.hooks.getByToken(token);
      return jsonOrCbor(c.req.raw, await wireHook(hook, refStore, 'resolve'));
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.post('/v2/hooks/create', async (c) => {
    try {
      const raw = await readRequestBuffer(c.req.raw);
      const body = parseRequestBody(c.req.raw, raw) as {
        runId: string;
        hookId: string;
        token: string;
        metadata?: unknown;
        isWebhook?: boolean;
      };
      const result = await createEvent(world, body.runId, {
        eventType: 'hook_created',
        correlationId: body.hookId,
        specVersion: SPEC_VERSION_CURRENT,
        eventData: { token: body.token, metadata: body.metadata },
      });
      if (!result.hook) {
        throw new WorkflowAPIError('Hook was not created', { status: 500 });
      }
      return jsonOrCbor(
        c.req.raw,
        await wireHook(result.hook, refStore, 'resolve')
      );
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.delete('/v2/hooks/:hookId', async (c) => {
    try {
      const hook = await world.hooks.get(c.req.param('hookId'));
      const result = await createEvent(world, hook.runId, {
        eventType: 'hook_disposed',
        correlationId: hook.hookId,
        specVersion: SPEC_VERSION_CURRENT,
      });
      return jsonOrCbor(
        c.req.raw,
        result.hook
          ? await wireHook(result.hook, refStore, 'resolve')
          : await wireHook(hook, refStore, 'resolve')
      );
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  // ---------------------------------------------------------------------------
  // v2 Streams & refs
  // ---------------------------------------------------------------------------
  api.put('/v2/runs/:runId/stream/:name', async (c) => {
    try {
      const runId = c.req.param('runId');
      const name = c.req.param('name');
      const isMulti = c.req.header('x-stream-multi') === 'true';
      const isDone = c.req.header('x-stream-done') === 'true';
      const buffer = new Uint8Array(await c.req.arrayBuffer());

      if (isDone) {
        await world.closeStream(name, runId);
        return new Response(null, { status: 204 });
      }

      if (isMulti && world.writeToStreamMulti) {
        const chunks = decodeMultiChunks(buffer);
        await world.writeToStreamMulti(name, runId, chunks);
      } else if (buffer.byteLength > 0) {
        await world.writeToStream(name, runId, buffer);
      }

      return new Response(null, { status: 204 });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/stream/:name', async (c) => {
    try {
      const startIndex = c.req.query('startIndex');
      const stream = await world.readFromStream(
        c.req.param('name'),
        startIndex ? Number(startIndex) : undefined
      );
      return new Response(stream, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/runs/:runId/streams', async (c) => {
    try {
      const streams = await world.listStreamsByRunId(c.req.param('runId'));
      return c.json(streams);
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.get('/v2/runs/:runId/refs', async (c) => {
    try {
      const ref = c.req.query('ref');
      if (!ref) {
        throw new WorkflowAPIError('ref is required', { status: 400 });
      }
      if (ref.startsWith('dbrf:')) {
        throw new WorkflowAPIError('Inline refs are client-resolved', {
          status: 400,
        });
      }
      const bytes = await refStore.getBytes(ref);
      return new Response(bytes, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  // ---------------------------------------------------------------------------
  // v1 compatibility
  // ---------------------------------------------------------------------------
  api.post('/v1/runs/create', async (c) => {
    try {
      const raw = await readRequestBuffer(c.req.raw);
      const body = parseRequestBody(c.req.raw, raw) as {
        deploymentId: string;
        workflowName: string;
        input: unknown;
        executionContext?: unknown;
        specVersion?: number;
      };
      const result = await createEvent(
        world,
        null,
        {
          eventType: 'run_created',
          specVersion: body.specVersion ?? SPEC_VERSION_CURRENT,
          eventData: {
            deploymentId: body.deploymentId,
            workflowName: body.workflowName,
            input: body.input,
            executionContext: body.executionContext as
              | Record<string, unknown>
              | undefined,
          },
        },
        { resolveData: 'all' }
      );
      if (!result.run) {
        throw new WorkflowAPIError('Run was not created', { status: 500 });
      }
      return jsonOrCbor(
        c.req.raw,
        await wireRun(result.run, refStore, 'resolve')
      );
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.put('/v1/runs/:runId/cancel', async (c) => {
    try {
      const behavior = parseRemoteRefBehavior(new URL(c.req.url));
      const resolveData = behavior === 'lazy' ? 'none' : 'all';
      const result = await createEvent(
        world,
        c.req.param('runId'),
        { eventType: 'run_cancelled', specVersion: SPEC_VERSION_CURRENT },
        { resolveData, v1Compat: true }
      );
      if (!result.run) {
        throw new WorkflowRunNotFoundError(c.req.param('runId'));
      }
      return jsonOrCbor(
        c.req.raw,
        await wireRun(result.run, refStore, behavior)
      );
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  api.post('/v1/runs/:runId/events', async (c) => {
    try {
      const raw = await readRequestBuffer(c.req.raw);
      const body = parseRequestBody(c.req.raw, raw);
      const parsed = CreateEventSchema.parse(body);
      const result = await createEvent(world, c.req.param('runId'), parsed, {
        resolveData: 'all',
        v1Compat: true,
      });
      return jsonOrCbor(c.req.raw, result.event ?? result);
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  // ---------------------------------------------------------------------------
  // Meta: encryption & deployments (api.vercel.com/v1/workflow parity)
  // ---------------------------------------------------------------------------
  const meta = new Hono();
  meta.use('*', authMiddleware(verify));

  meta.get('/run-key/:deploymentId', async (c) => {
    try {
      const projectId = c.req.query('projectId') || config.projectId;
      const runId = c.req.query('runId');
      if (!projectId || !runId) {
        throw new WorkflowAPIError('projectId and runId are required', {
          status: 400,
        });
      }
      const keyBase64 = config.deploymentKeyBase64;
      if (!keyBase64) {
        return c.json({ key: null });
      }
      const deploymentKey = Buffer.from(keyBase64, 'base64');
      const derived = await deriveRunKey(
        new Uint8Array(deploymentKey),
        projectId,
        runId
      );
      return c.json({ key: Buffer.from(derived).toString('base64') });
    } catch (error) {
      return errorResponse(c.req.raw, error);
    }
  });

  meta.get('/resolve-latest-deployment/:deploymentId', async (c) => {
    return c.json({ id: c.req.param('deploymentId') });
  });

  const app = new Hono();
  app.route('/api', api);
  app.route('/v1/workflow', meta);

  return {
    app,
    context,
    async close() {
      await context.world.close?.();
    },
  };
}
