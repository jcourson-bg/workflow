#!/usr/bin/env node
import { serveWorkflowServer } from '../dist/serve.js';

serveWorkflowServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
