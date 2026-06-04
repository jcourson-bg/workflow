import { WorkflowAPIError } from '@workflow/errors';
import { encodeResponseBody } from './cbor.js';

export async function jsonOrCbor(
  request: Request,
  data: unknown,
  init?: ResponseInit
): Promise<Response> {
  const accept = request.headers.get('accept');
  const { body, contentType } = encodeResponseBody(data, accept);
  return new Response(body, {
    ...init,
    headers: {
      'content-type': contentType,
      ...(init?.headers ?? {}),
    },
  });
}

export async function errorResponse(
  request: Request,
  error: unknown
): Promise<Response> {
  if (error instanceof WorkflowAPIError) {
    const apiError = error;
    const headers: Record<string, string> = {};
    if (apiError.status === 429 && apiError.retryAfter) {
      headers['Retry-After'] = String(apiError.retryAfter);
    }
    return jsonOrCbor(
      request,
      { message: apiError.message, code: apiError.code },
      { status: apiError.status, headers }
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return jsonOrCbor(request, { message }, { status: 500 });
}
