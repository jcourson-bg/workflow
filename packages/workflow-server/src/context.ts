import { createWorld } from '@workflow/world-postgres';
import type { World } from '@workflow/world';
import type { WorkflowServerConfig } from './config.js';
import { resolveConfig } from './config.js';
import { RefStore } from './refs/store.js';

export interface WorkflowServerContext {
  config: ReturnType<typeof resolveConfig>;
  world: World & { close?: () => Promise<void> };
  refStore: RefStore;
}

export function createContext(
  userConfig: WorkflowServerConfig = {}
): WorkflowServerContext {
  const config = resolveConfig(userConfig);
  const world = createWorld(config.postgres);
  const refStore = new RefStore({
    inlineThreshold: config.inlineRefThreshold!,
    blobToken: config.blobReadWriteToken,
    dataDir: config.refDataDir,
  });
  return { config, world, refStore };
}
