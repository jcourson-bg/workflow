import type { PostgresWorldConfig } from '@workflow/world-postgres';

export type AuthVerifier = (
  request: Request
) => Promise<{ ok: true } | { ok: false; status: number; message: string }>;

export interface WorkflowServerConfig {
  /** PostgreSQL connection for workflow storage */
  postgres?: PostgresWorldConfig;
  /**
   * Bearer tokens accepted for API auth (defaults to WORKFLOW_SERVER_AUTH_TOKEN).
   * Set to empty array to disable auth (development only).
   */
  authTokens?: string[];
  /** Custom auth verifier; overrides authTokens when set */
  auth?: AuthVerifier;
  /** Vercel Blob token for s3rf: refs (optional; uses in-memory refs when unset) */
  blobReadWriteToken?: string;
  /** Directory for filesystem-backed refs when blob is not configured */
  refDataDir?: string;
  /** Inline ref threshold in bytes (default 4096) */
  inlineRefThreshold?: number;
  /** Base64 deployment key for per-run encryption (optional) */
  deploymentKeyBase64?: string;
  /** Project ID for HKDF encryption context */
  projectId?: string;
  /** Team ID header echo (optional, for proxy compatibility) */
  teamId?: string;
}

export function resolveConfig(
  config: WorkflowServerConfig = {}
): Required<Pick<WorkflowServerConfig, 'inlineRefThreshold'>> &
  WorkflowServerConfig {
  return {
    inlineRefThreshold: config.inlineRefThreshold ?? 4096,
    ...config,
    postgres: config.postgres ?? {
      connectionString:
        process.env.WORKFLOW_POSTGRES_URL ||
        process.env.DATABASE_URL ||
        'postgres://world:world@localhost:5432/world',
      jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
      queueConcurrency: parseInt(
        process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '10',
        10
      ),
    },
    authTokens:
      config.authTokens ??
      (process.env.WORKFLOW_SERVER_AUTH_TOKEN
        ? [process.env.WORKFLOW_SERVER_AUTH_TOKEN]
        : process.env.NODE_ENV === 'production'
          ? []
          : ['dev-workflow-server-token']),
    blobReadWriteToken:
      config.blobReadWriteToken ?? process.env.BLOB_READ_WRITE_TOKEN,
    refDataDir:
      config.refDataDir ??
      process.env.WORKFLOW_SERVER_REF_DIR ??
      '.workflow-server-refs',
    deploymentKeyBase64:
      config.deploymentKeyBase64 ?? process.env.WORKFLOW_DEPLOYMENT_KEY,
    projectId: config.projectId ?? process.env.WORKFLOW_SERVER_PROJECT_ID,
    teamId: config.teamId ?? process.env.WORKFLOW_SERVER_TEAM_ID,
  };
}
