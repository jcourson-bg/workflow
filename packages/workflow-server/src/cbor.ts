import { decode, encode } from 'cbor-x';

export function parseRequestBody(request: Request, raw: ArrayBuffer): unknown {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/cbor')) {
    return decode(new Uint8Array(raw));
  }
  const text = new TextDecoder().decode(raw);
  if (!text) {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

export function encodeResponseBody(
  data: unknown,
  accept: string | null
): { body: Uint8Array; contentType: string } {
  if (accept?.includes('application/cbor')) {
    return {
      body: encode(data),
      contentType: 'application/cbor',
    };
  }
  return {
    body: new TextEncoder().encode(JSON.stringify(data)),
    contentType: 'application/json',
  };
}

export async function readRequestBuffer(
  request: Request
): Promise<ArrayBuffer> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new ArrayBuffer(0);
  }
  return request.arrayBuffer();
}
