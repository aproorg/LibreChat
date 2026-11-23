import JSZip from 'jszip';
import { Readable } from 'stream';
import type { S3Client } from '@aws-sdk/client-s3';

/** In-memory S3 feed helpers shared by the s3 adapter and sync specs. */
export async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/** Fake bucket: a missing key rejects like S3 does with `NoSuchKey`. */
export function fakeS3(
  objects: Record<string, Uint8Array | string>,
  /** Overrides the reported ContentLength (null omits it) to exercise the size caps. */
  contentLength?: (key: string, size: number) => number | null,
): Pick<S3Client, 'send'> {
  return {
    send: jest.fn(async (command: { input: { Key: string } }) => {
      const body = objects[command.input.Key];
      if (body === undefined) {
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      }
      const bytes = typeof body === 'string' ? Buffer.from(body) : body;
      const length = contentLength ? contentLength(command.input.Key, bytes.length) : bytes.length;
      return {
        Body: Readable.from([Buffer.from(bytes)]),
        ContentLength: length ?? undefined,
      };
    }),
  } as unknown as Pick<S3Client, 'send'>;
}

export function marketplace(plugins: Array<{ name: string; url: string; sha256: string }>) {
  return JSON.stringify({
    name: 'apro-company',
    owner: { name: 'APRO' },
    plugins: plugins.map((p) => ({
      name: p.name,
      description: 'd',
      version: '1.0.0',
      source: { source: 'archive', url: p.url, sha256: p.sha256 },
    })),
  });
}
