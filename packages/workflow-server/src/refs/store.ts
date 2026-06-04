import fs from 'node:fs/promises';
import path from 'node:path';
import { put } from '@vercel/blob';

export interface RefDescriptor {
  _type: 'RemoteRef';
  _ref: string;
  _data?: string;
  _ct?: string;
}

const INLINE_PREFIX = 'dbrf:';
const BLOB_PREFIX = 's3rf:';
const FS_PREFIX = 'fsrf:';

export class RefStore {
  private memory = new Map<string, Uint8Array>();

  constructor(
    private readonly options: {
      inlineThreshold: number;
      blobToken?: string;
      dataDir?: string;
    }
  ) {}

  async putBytes(
    key: string,
    bytes: Uint8Array,
    contentType = 'application/octet-stream'
  ): Promise<RefDescriptor> {
    if (bytes.byteLength <= this.options.inlineThreshold) {
      return {
        _type: 'RemoteRef',
        _ref: `${INLINE_PREFIX}${key}`,
        _data: Buffer.from(bytes).toString('base64'),
        _ct: contentType,
      };
    }

    if (this.options.blobToken) {
      const blob = await put(`workflow-refs/${key}`, Buffer.from(bytes), {
        access: 'public',
        token: this.options.blobToken,
        contentType,
        addRandomSuffix: false,
      });
      return {
        _type: 'RemoteRef',
        _ref: `${BLOB_PREFIX}${blob.url}`,
      };
    }

    if (this.options.dataDir) {
      const filePath = path.join(this.options.dataDir, key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, bytes);
      return {
        _type: 'RemoteRef',
        _ref: `${FS_PREFIX}${key}`,
      };
    }

    this.memory.set(key, bytes);
    return {
      _type: 'RemoteRef',
      _ref: `${FS_PREFIX}${key}`,
    };
  }

  async getBytes(ref: string): Promise<Uint8Array> {
    if (ref.startsWith(INLINE_PREFIX)) {
      throw new Error('Inline refs must be resolved from descriptor._data');
    }

    const key = ref.replace(/^(s3rf:|fsrf:)/, '');

    if (ref.startsWith(BLOB_PREFIX)) {
      const url = ref.slice(BLOB_PREFIX.length);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch blob ref: ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }

    if (this.options.dataDir) {
      const filePath = path.join(
        this.options.dataDir,
        ref.startsWith(FS_PREFIX) ? ref.slice(FS_PREFIX.length) : key
      );
      return new Uint8Array(await fs.readFile(filePath));
    }

    const memKey = ref.startsWith(FS_PREFIX)
      ? ref.slice(FS_PREFIX.length)
      : key;
    const cached = this.memory.get(memKey);
    if (!cached) {
      throw new Error(`Ref not found: ${ref}`);
    }
    return cached;
  }

  static decodeInline(descriptor: RefDescriptor): Uint8Array {
    if (!descriptor._data) {
      throw new Error(`Missing inline data for ref ${descriptor._ref}`);
    }
    return new Uint8Array(Buffer.from(descriptor._data, 'base64'));
  }
}

export function isRefDescriptor(value: unknown): value is RefDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as RefDescriptor)._type === 'RemoteRef' &&
    typeof (value as RefDescriptor)._ref === 'string'
  );
}
