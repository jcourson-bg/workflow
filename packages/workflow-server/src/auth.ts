import type { AuthVerifier, WorkflowServerConfig } from './config.js';

export function createDefaultAuthVerifier(tokens: string[]): AuthVerifier {
  return async (request) => {
    if (tokens.length === 0) {
      return {
        ok: false,
        status: 401,
        message: 'Workflow server auth is not configured',
      };
    }

    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) {
      return { ok: false, status: 401, message: 'Missing Bearer token' };
    }

    const token = header.slice('Bearer '.length);
    if (!tokens.includes(token)) {
      return { ok: false, status: 403, message: 'Invalid token' };
    }

    return { ok: true };
  };
}

export function resolveAuthVerifier(
  config: WorkflowServerConfig
): AuthVerifier {
  if (config.auth) {
    return config.auth;
  }
  const tokens = config.authTokens ?? [];
  return createDefaultAuthVerifier(tokens);
}
