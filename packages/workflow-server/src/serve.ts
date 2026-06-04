import { serve } from '@hono/node-server';
import type { WorkflowServerConfig } from './config.js';
import { createWorkflowServer } from './create-app.js';

export async function serveWorkflowServer(
  config: WorkflowServerConfig & { port?: number } = {}
): Promise<{ close: () => Promise<void> }> {
  const port = config.port ?? Number(process.env.PORT || '3001');
  const { app, close } = createWorkflowServer(config);

  const server = serve({
    fetch: app.fetch,
    port,
  });

  console.log(
    `@workflow/workflow-server listening on http://localhost:${port}`
  );
  console.log(`  API base: http://localhost:${port}/api`);
  console.log(`  Health:   http://localhost:${port}/api/health`);

  return {
    async close() {
      await close();
      server.close();
    },
  };
}
