import JSZip from 'jszip';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { AllMethods, ISkill } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ImportSkillDeps } from './import';
import { createReplaceImportHandler, createImportHandler } from './import';

type Handler = ReturnType<typeof createReplaceImportHandler>;
type ImportRequest = Parameters<Handler>[0];
type Skill = ISkill & { _id: Types.ObjectId };
type Body = Record<string, unknown> & { _id?: string; version?: number; error?: string };
interface MockResponse extends Response {
  body?: unknown;
}
type ReplaceDeps = Parameters<typeof createReplaceImportHandler>[0];

let server: MongoMemoryServer;
let db: AllMethods;
let blobs: Map<string, Buffer>;
let failSaveAt: number | undefined;
let saves: number;

const alice = new Types.ObjectId();
const bob = new Types.ObjectId();

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  blobs = new Map();
  failSaveAt = undefined;
  saves = 0;
});

function importDeps(): ImportSkillDeps {
  return {
    createSkill: db.createSkill,
    getSkillById: db.getSkillById,
    deleteSkill: db.deleteSkill,
    upsertSkillFile: db.upsertSkillFile,
    getSkillFileByPath: db.getSkillFileByPath,
    reserveSkillUploadIntent: db.reserveSkillUploadIntent,
    transitionSkillUploadIntent: db.transitionSkillUploadIntent,
    reserveBlob: async (_req, { userId, fileName, tenantId }) => ({
      filepath: `/blobs/${fileName}`,
      source: 'local',
      writeLocation: { userId, fileName, basePath: 'uploads' as const, tenantId },
    }),
    saveBuffer: async (_req, { reservation, buffer }) => {
      saves += 1;
      if (saves === failSaveAt) {
        throw new Error('storage down at s3://secret-bucket');
      }
      blobs.set(reservation.filepath, buffer);
      return { filepath: reservation.filepath, source: 'local' };
    },
    deleteFile: async (_req, file) => {
      blobs.delete(file.filepath);
    },
    grantPermission: async () => undefined,
  };
}

const replaceHandler = (overrides: Partial<ReplaceDeps> = {}) =>
  createReplaceImportHandler({
    ...importDeps(),
    updateSkill: db.updateSkill,
    listSkillFiles: db.listSkillFiles,
    deleteSkillFile: db.deleteSkillFile,
    getAuthorSkillByName: db.getAuthorSkillByName,
    ...overrides,
  });

async function archive(
  files: Record<string, string>,
  { description = 'Does the thing', body = 'Body text' } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('SKILL.md', `---\nname: my-skill\ndescription: ${description}\n---\n${body}`);
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function rawArchive(skillMd?: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(skillMd == null ? 'a.txt' : 'SKILL.md', skillMd ?? 'A');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function send(handler: Handler, userId: Types.ObjectId, buffer: Buffer) {
  const res = {} as MockResponse;
  res.status = ((code: number) => {
    res.statusCode = code;
    return res;
  }) as MockResponse['status'];
  res.json = ((body: unknown) => {
    res.body = body;
    return res;
  }) as MockResponse['json'];
  const req = {
    user: { id: userId.toString(), _id: userId, name: 'U' },
    file: { originalname: 'my-skill.zip', buffer },
    config: {},
  } as unknown as ImportRequest;
  await handler(req, res);
  return { status: res.statusCode, body: res.body as Body };
}

const stored = async (id: string) => {
  const skill = (await db.getSkillById(id)) as Skill;
  const rows = await db.listSkillFiles(id);
  return { skill, files: rows.map((f) => f.relativePath).sort(), rows };
};

describe('PUT /api/skills/import (replace)', () => {
  it('creates like POST when the caller has no skill of that name', async () => {
    const zip = await archive({ 'a.txt': 'A' });
    const put = await send(replaceHandler(), alice, zip);
    expect(put.status).toBe(201);
    expect(put.body.name).toBe('my-skill');
    expect(put.body._importSummary).toMatchObject({ filesSucceeded: 1, filesFailed: 0 });
    const post = await send(createImportHandler(importDeps()), bob, zip);
    expect(post.status).toBe(201);
    expect(Object.keys(put.body).sort()).toEqual(Object.keys(post.body).sort());
  });

  it('replaces in place: same _id, new file set, old blobs removed', async () => {
    const handler = replaceHandler();
    const first = await send(handler, alice, await archive({ 'keep.txt': 'v1', 'gone.txt': 'x' }));
    const id = String(first.body._id);
    const before = await stored(id);
    const oldBlobPaths = before.rows.map((r) => r.filepath);

    const second = await send(
      handler,
      alice,
      await archive({ 'keep.txt': 'v2', 'new.txt': 'N' }, { description: 'Changed', body: 'New' }),
    );
    expect(second.status).toBe(200);
    expect(String(second.body._id)).toBe(id);
    expect(second.body.description).toBe('Changed');
    expect(second.body.version as number).toBeGreaterThan(before.skill.version);
    expect(second.body._importSummary).toMatchObject({ filesSucceeded: 2, filesFailed: 0 });

    const after = await stored(id);
    expect(after.skill.body).toContain('New');
    expect(after.skill.fileCount).toBe(2);
    expect(after.files).toEqual(['keep.txt', 'new.txt']);
    for (const old of oldBlobPaths) {
      expect(blobs.has(old)).toBe(false);
    }
    expect([...blobs.keys()].sort()).toEqual(after.rows.map((r) => r.filepath).sort());
  });

  it('is repeat-safe with an identical archive', async () => {
    const handler = replaceHandler();
    const zip = await archive({ 'a.txt': 'A' });
    const first = await send(handler, alice, zip);
    const second = await send(handler, alice, zip);
    const third = await send(handler, alice, zip);
    expect([second.status, third.status]).toEqual([200, 200]);
    expect(String(second.body._id)).toBe(String(first.body._id));
    expect(String(third.body._id)).toBe(String(first.body._id));
    expect(blobs.size).toBe(1);
  });

  it('never touches another author skill of the same name', async () => {
    const post = createImportHandler(importDeps());
    const theirs = await send(post, bob, await archive({ 'b.txt': 'B' }));
    const theirsBefore = await stored(String(theirs.body._id));
    const blobsBefore = [...blobs.keys()];

    const mine = await send(replaceHandler(), alice, await archive({ 'a.txt': 'A' }));
    expect(mine.status).toBe(201);
    expect(String(mine.body._id)).not.toBe(String(theirs.body._id));

    expect(await stored(String(theirs.body._id))).toEqual(theirsBefore);
    expect(blobsBefore.every((p) => blobs.has(p))).toBe(true);
  });

  it('answers 400 and leaves the stored skill alone on a bad archive', async () => {
    const handler = replaceHandler();
    const first = await send(handler, alice, await archive({ 'a.txt': 'A' }));
    const id = String(first.body._id);
    const before = await stored(id);

    const badYaml = await rawArchive('---\nname: my-skill\ndescription: [unclosed\n---\nbody');
    const badBool = await rawArchive(
      '---\nname: my-skill\ndescription: d\nalways-apply: maybe\n---\nbody',
    );
    const statuses = [
      (await send(handler, alice, badYaml)).status,
      (await send(handler, alice, badBool)).status,
      (await send(handler, alice, await rawArchive())).status,
    ];

    expect(statuses).toEqual([400, 400, 400]);
    expect(await stored(id)).toEqual(before);
  });

  it('cancels with consistent:true when a storage write fails before any DB change', async () => {
    const handler = replaceHandler();
    const first = await send(handler, alice, await archive({ 'a.txt': 'A', 'b.txt': 'B' }));
    const id = String(first.body._id);
    const before = await stored(id);
    const blobsBefore = [...blobs.keys()].sort();

    failSaveAt = saves + 2;
    const res = await send(
      handler,
      alice,
      await archive({ 'a.txt': 'A2', 'b.txt': 'B2' }, { body: 'Changed' }),
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'skill_import_incomplete', consistent: true });
    expect(JSON.stringify(res.body)).not.toContain('secret-bucket');
    expect(await stored(id)).toEqual(before);
    expect([...blobs.keys()].sort()).toEqual(blobsBefore);
  });

  it('reports consistent:false when a failure happens after rows were written', async () => {
    const first = await send(
      replaceHandler(),
      alice,
      await archive({ 'a.txt': 'A', 'b.txt': 'B' }),
    );
    const id = String(first.body._id);
    let calls = 0;
    const failing = replaceHandler({
      upsertSkillFile: async (row) => {
        calls += 1;
        if (calls === 2) {
          throw new Error('db down');
        }
        return db.upsertSkillFile(row);
      },
    });
    const res = await send(failing, alice, await archive({ 'a.txt': 'A2', 'b.txt': 'B2' }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'skill_import_incomplete',
      consistent: false,
      failedFiles: [{ path: 'b.txt', reason: 'persistence_failed' }],
    });
    expect((await stored(id)).files).toEqual(['a.txt', 'b.txt']);
  });

  it('answers 409 skill_version_conflict when the skill changes underneath the import', async () => {
    const first = await send(replaceHandler(), alice, await archive({ 'a.txt': 'A' }));
    const id = String(first.body._id);
    const racing = replaceHandler({
      listSkillFiles: async (skillId) => {
        const rows = await db.listSkillFiles(skillId);
        await db.updateSkill({
          id,
          expectedVersion: (await db.getSkillById(id))?.version ?? 0,
          update: { description: 'edited elsewhere' },
        });
        return rows;
      },
    });
    const res = await send(racing, alice, await archive({ 'a.txt': 'A2' }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'skill_version_conflict', consistent: true });
    expect((await db.getSkillById(id))?.description).toBe('edited elsewhere');
    expect(blobs.size).toBe(1);
  });

  it('lets only one of two concurrent replaces write; the loser leaves nothing behind', async () => {
    const first = await send(replaceHandler(), alice, await archive({ 'a.txt': 'A' }));
    const id = String(first.body._id);
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = replaceHandler({
      listSkillFiles: async (skillId) => {
        const rows = await db.listSkillFiles(skillId);
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await gate;
        return rows;
      },
    });
    const [x, y] = await Promise.all([
      send(barrier, alice, await archive({ 'a.txt': 'A', 'x.txt': 'X' }, { body: 'from x' })),
      send(barrier, alice, await archive({ 'a.txt': 'A', 'y.txt': 'Y' }, { body: 'from y' })),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const winner = x.status === 200 ? 'x.txt' : 'y.txt';
    const after = await stored(id);
    expect(after.files).toEqual(['a.txt', winner]);
    expect(after.skill.body).toContain(x.status === 200 ? 'from x' : 'from y');
    expect(blobs.size).toBe(2);
  });
});
