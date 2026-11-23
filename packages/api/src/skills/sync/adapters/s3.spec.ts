import JSZip from 'jszip';
import crypto from 'crypto';
import { fakeS3, makeZip, marketplace } from './s3.testing';
import { createS3PluginAdapter } from './s3';

const KEY = 'catalogue/company/marketplace.json';
const source = {
  type: 's3' as const,
  id: 'company',
  bucket: 'skills-bucket',
  key: KEY,
  region: 'eu-west-1',
};
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const noop = () => undefined;

const pluginFiles = {
  '.claude-plugin/plugin.json': '{}',
  'skills/research/SKILL.md': '---\nname: research\ndescription: d\n---\nBody',
  'skills/research/scripts/run.sh': 'echo hi',
  'README.md': 'ignored',
};

async function feed(zipBytes?: Uint8Array, url = 'plugins/p-1.zip', declaredSha?: string) {
  const bytes = zipBytes ?? (await makeZip(pluginFiles));
  const objects = {
    [KEY]: marketplace([{ name: 'p', url, sha256: declaredSha ?? sha(bytes) }]),
    'catalogue/company/plugins/p-1.zip': bytes,
  };
  return { bytes, s3: fakeS3(objects) };
}

describe('createS3PluginAdapter', () => {
  it('lists one entry per file under skills/<skill>/ and serves their bytes', async () => {
    const { s3 } = await feed();
    const adapter = createS3PluginAdapter({ source, s3 });
    const commit = await adapter.resolveCommit();
    const entries = await adapter.fetchTreeEntries(commit, {
      pathPrefix: '',
      assertNotCancelled: noop,
    });

    expect(entries.map((e) => e.path).sort()).toEqual([
      'p/skills/research/SKILL.md',
      'p/skills/research/scripts/run.sh',
    ]);
    const script = entries.find((e) => e.path.endsWith('run.sh')) as (typeof entries)[number];
    expect(script.size).toBe(7);
    expect((await adapter.fetchFileContent(commit, script)).toString()).toBe('echo hi');
  });

  it('derives the commit id from the sorted zip shas and caches the load', async () => {
    const { bytes, s3 } = await feed();
    const adapter = createS3PluginAdapter({ source, s3 });
    const commit = await adapter.resolveCommit();
    await adapter.resolveCommit();

    expect(commit.id).toBe(sha(Buffer.from(sha(bytes))));
    expect(s3.send).toHaveBeenCalledTimes(2);
  });

  it('fails when the marketplace cannot be read', async () => {
    const adapter = createS3PluginAdapter({ source, s3: fakeS3({}) });
    await expect(adapter.resolveCommit()).rejects.toMatchObject({ code: 'S3_READ_FAILED' });
  });

  it('fails on a sha256 mismatch', async () => {
    const { s3 } = await feed(undefined, 'plugins/p-1.zip', 'a'.repeat(64));
    const adapter = createS3PluginAdapter({ source, s3 });
    await expect(adapter.resolveCommit()).rejects.toMatchObject({ code: 'S3_INVALID_ARCHIVE' });
  });

  it('fails on a corrupt zip', async () => {
    const corrupt = Buffer.from('not a zip');
    const { s3 } = await feed(corrupt);
    const adapter = createS3PluginAdapter({ source, s3 });
    await expect(adapter.resolveCommit()).rejects.toMatchObject({ code: 'S3_INVALID_ARCHIVE' });
  });

  it.each(['../secret.zip', '/abs/p.zip', 'https://evil.example/p.zip', 'plugins/../../p.zip'])(
    'rejects the unsafe archive url %s without reading it',
    async (url) => {
      const { s3 } = await feed(undefined, url);
      const adapter = createS3PluginAdapter({ source, s3 });
      await expect(adapter.resolveCommit()).rejects.toMatchObject({
        code: 'S3_INVALID_MARKETPLACE',
      });
      expect(s3.send).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a zip entry that escapes via ..', async () => {
    const zip = new JSZip();
    zip.file('skills/x/../../evil.txt', 'x');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const { s3 } = await feed(bytes);
    const adapter = createS3PluginAdapter({ source, s3 });
    await expect(adapter.resolveCommit()).rejects.toMatchObject({ code: 'S3_INVALID_ARCHIVE' });
  });

  it('rejects a zip with too many entries', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= 2000; i++) {
      files[`skills/s/f${i}.txt`] = 'x';
    }
    const { s3 } = await feed(await makeZip(files));
    const adapter = createS3PluginAdapter({ source, s3 });
    await expect(adapter.resolveCommit()).rejects.toMatchObject({ code: 'S3_INVALID_ARCHIVE' });
  });

  it('rejects an invalid marketplace shape', async () => {
    const adapter = createS3PluginAdapter({ source, s3: fakeS3({ [KEY]: '{"plugins":"no"}' }) });
    await expect(adapter.resolveCommit()).rejects.toMatchObject({ code: 'S3_INVALID_MARKETPLACE' });
  });
});
