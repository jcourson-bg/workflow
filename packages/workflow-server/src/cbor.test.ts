import { describe, expect, it } from 'vitest';
import { encodeResponseBody, parseRequestBody } from './cbor.js';

describe('cbor', () => {
  it('round-trips JSON', () => {
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const req = new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(parseRequestBody(req, body.buffer)).toEqual({ ok: true });
    const out = encodeResponseBody({ ok: true }, 'application/json');
    expect(JSON.parse(new TextDecoder().decode(out.body))).toEqual({
      ok: true,
    });
  });
});
