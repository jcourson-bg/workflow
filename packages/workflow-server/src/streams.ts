/**
 * Length-prefixed multi-chunk format from @workflow/world-vercel streamer.
 */
export function decodeMultiChunks(buffer: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.byteLength) {
    const length =
      (buffer[offset]! << 24) |
      (buffer[offset + 1]! << 16) |
      (buffer[offset + 2]! << 8) |
      buffer[offset + 3]!;
    offset += 4;
    chunks.push(buffer.slice(offset, offset + length));
    offset += length;
  }
  return chunks;
}

export function encodeMultiChunks(chunks: (string | Uint8Array)[]): Uint8Array {
  const encoder = new TextEncoder();
  const binaryChunks: Uint8Array[] = [];
  let totalSize = 0;

  for (const chunk of chunks) {
    const binary = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    binaryChunks.push(binary);
    totalSize += 4 + binary.byteLength;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const binary of binaryChunks) {
    result[offset] = (binary.byteLength >>> 24) & 0xff;
    result[offset + 1] = (binary.byteLength >>> 16) & 0xff;
    result[offset + 2] = (binary.byteLength >>> 8) & 0xff;
    result[offset + 3] = binary.byteLength & 0xff;
    offset += 4;
    result.set(binary, offset);
    offset += binary.byteLength;
  }
  return result;
}
