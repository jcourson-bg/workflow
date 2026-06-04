import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { type RefDescriptor, isRefDescriptor, RefStore } from './refs/store.js';

export type RemoteRefBehavior = 'lazy' | 'resolve';

export const eventDataRefFieldMap: Record<string, string> = {
  run_created: 'input',
  run_completed: 'output',
  run_failed: 'error',
  step_created: 'input',
  step_completed: 'result',
  step_failed: 'error',
  step_retrying: 'error',
  hook_created: 'metadata',
};

function serializeValue(value: unknown): Uint8Array | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  return new TextEncoder().encode(JSON.stringify(value));
}

async function toRefField(
  store: RefStore,
  key: string,
  value: unknown,
  behavior: RemoteRefBehavior
): Promise<{ ref?: RefDescriptor; inline?: unknown }> {
  if (behavior === 'resolve') {
    return { inline: value };
  }
  const bytes = serializeValue(value);
  if (!bytes || bytes.byteLength === 0) {
    return { inline: value };
  }
  const descriptor = await store.putBytes(key, bytes);
  return { ref: descriptor, inline: undefined };
}

export async function wireRun(
  run: WorkflowRun | Record<string, unknown>,
  store: RefStore,
  behavior: RemoteRefBehavior
): Promise<Record<string, unknown>> {
  if (behavior === 'resolve') {
    return run as unknown as Record<string, unknown>;
  }

  const base = { ...run } as Record<string, unknown>;
  const inputKey = `${run.runId}/input`;
  const outputKey = `${run.runId}/output`;

  if (run.input !== undefined) {
    const { ref } = await toRefField(store, inputKey, run.input, 'lazy');
    base.input = undefined;
    base.inputRef = ref;
  }
  if (run.output !== undefined) {
    const { ref } = await toRefField(store, outputKey, run.output, 'lazy');
    base.output = undefined;
    base.outputRef = ref;
  }
  const err = (run as WorkflowRun).error;
  if (err) {
    base.error = JSON.stringify({
      message: err.message,
      stack: err.stack,
      code: err.code,
    });
  }
  return base;
}

export async function wireStep(
  step: Step,
  store: RefStore,
  behavior: RemoteRefBehavior
): Promise<Record<string, unknown>> {
  if (behavior === 'resolve') {
    return step as unknown as Record<string, unknown>;
  }

  const base = { ...step } as Record<string, unknown>;
  if (step.input !== undefined) {
    const { ref } = await toRefField(
      store,
      `${step.runId}/steps/${step.stepId}/input`,
      step.input,
      'lazy'
    );
    base.input = undefined;
    base.inputRef = ref;
  }
  if (step.output !== undefined) {
    const { ref } = await toRefField(
      store,
      `${step.runId}/steps/${step.stepId}/output`,
      step.output,
      'lazy'
    );
    base.output = undefined;
    base.outputRef = ref;
  }
  if (step.error) {
    base.error = JSON.stringify({
      message: step.error.message,
      stack: step.error.stack,
      code: step.error.code,
    });
  }
  return base;
}

export async function wireHook(
  hook: Hook,
  store: RefStore,
  behavior: RemoteRefBehavior
): Promise<Record<string, unknown>> {
  if (behavior === 'resolve') {
    return hook as unknown as Record<string, unknown>;
  }
  const base = { ...hook } as Record<string, unknown>;
  if (hook.metadata !== undefined) {
    const { ref } = await toRefField(
      store,
      `${hook.runId}/hooks/${hook.hookId}/metadata`,
      hook.metadata,
      'lazy'
    );
    base.metadata = undefined;
    base.metadataRef = ref;
  }
  return base;
}

export async function wireEvent(
  event: Event,
  store: RefStore,
  behavior: RemoteRefBehavior
): Promise<Record<string, unknown>> {
  if (behavior === 'resolve') {
    return event as unknown as Record<string, unknown>;
  }

  const base = { ...event } as Record<string, unknown>;
  const field = eventDataRefFieldMap[event.eventType];
  const eventData = (event as { eventData?: unknown }).eventData;

  if (field && eventData !== undefined) {
    const key = `${event.runId}/events/${event.eventId}/${field}`;
    const value = (eventData as Record<string, unknown>)[field];
    if (value !== undefined) {
      const { ref } = await toRefField(store, key, value, 'lazy');
      const lazyData = { ...(eventData as Record<string, unknown>) };
      lazyData[field] = ref;
      base.eventData = lazyData;
    }
  } else if (eventData !== undefined) {
    const { ref } = await toRefField(
      store,
      `${event.runId}/events/${event.eventId}/eventData`,
      eventData,
      'lazy'
    );
    base.eventData = undefined;
    base.eventDataRef = ref;
  }

  return base;
}

export function parseRemoteRefBehavior(url: URL): RemoteRefBehavior {
  const value = url.searchParams.get('remoteRefBehavior');
  if (value === 'lazy' || value === 'resolve') {
    return value;
  }
  const resolveData = url.searchParams.get('resolveData');
  if (resolveData === 'none') {
    return 'lazy';
  }
  return 'resolve';
}

export function wireErrorField(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') {
    return error;
  }
  return JSON.stringify(error);
}

export async function resolveRefValue(
  store: RefStore,
  descriptor: RefDescriptor
): Promise<unknown> {
  if (descriptor._ref.startsWith('dbrf:')) {
    const bytes = RefStore.decodeInline(descriptor);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return bytes;
    }
  }
  const bytes = await store.getBytes(descriptor._ref);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return bytes;
  }
}

export async function deepResolveRefs(
  store: RefStore,
  value: unknown
): Promise<unknown> {
  if (isRefDescriptor(value)) {
    return resolveRefValue(store, value);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => deepResolveRefs(store, v)));
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([k, v]) => [
        k,
        await deepResolveRefs(store, v),
      ])
    );
    return Object.fromEntries(entries);
  }
  return value;
}
