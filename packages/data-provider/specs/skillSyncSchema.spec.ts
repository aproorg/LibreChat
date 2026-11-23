import { skillSyncConfigSchema } from '../src/config';

const github = {
  id: 'gh',
  owner: 'acme',
  repo: 'skills',
  paths: ['skills'],
  token: '${GITHUB_SKILLS_TOKEN}',
};
const s3 = {
  type: 's3',
  id: 'company',
  bucket: 'skills-bucket',
  key: 'catalogue/company/marketplace.json',
  region: 'eu-west-1',
};
const parse = (sources: unknown[]) =>
  skillSyncConfigSchema.safeParse({ github: { enabled: true, sources } });

describe('skillSyncConfigSchema sources', () => {
  it('accepts an s3 source', () => {
    expect(parse([s3]).success).toBe(true);
  });

  it('still accepts a github source without type, and with type github', () => {
    expect(parse([github]).success).toBe(true);
    expect(parse([{ ...github, type: 'github' }]).success).toBe(true);
  });

  it('still rejects a github source with no credential', () => {
    const { token: _token, ...noCredential } = github;
    expect(parse([noCredential]).success).toBe(false);
  });

  it('rejects an s3 source with a traversal key or missing bucket', () => {
    expect(parse([{ ...s3, key: 'catalogue/../x/marketplace.json' }]).success).toBe(false);
    expect(parse([{ ...s3, bucket: undefined }]).success).toBe(false);
  });

  it.each(['a', 'Upper-case', '-lead', 'trail-', 'has_underscore', 'x'.repeat(64)])(
    'rejects the bucket %s',
    (bucket) => expect(parse([{ ...s3, bucket }]).success).toBe(false),
  );

  it.each(['abc', 'my.bucket-1'])('accepts the bucket %s', (bucket) =>
    expect(parse([{ ...s3, bucket }]).success).toBe(true),
  );

  it.each(['eu-west-1', 'us-gov-east-1', 'ap-southeast-2'])('accepts the region %s', (region) =>
    expect(parse([{ ...s3, region }]).success).toBe(true),
  );

  it.each(['europe', 'EU-WEST-1', 'eu-west-', 'eu-west-12', 'eu_west_1'])(
    'rejects the region %s',
    (region) => expect(parse([{ ...s3, region }]).success).toBe(false),
  );

  it.each(['/abs/marketplace.json', 'a\\b.json', 'a//b.json', 'a/b/', 'a/../b.json', '..'])(
    'rejects the key %s',
    (key) => expect(parse([{ ...s3, key }]).success).toBe(false),
  );

  it('rejects duplicate ids across source types', () => {
    expect(parse([s3, { ...github, id: 'company' }]).success).toBe(false);
  });
});
