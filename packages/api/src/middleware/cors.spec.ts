import express from 'express';
import request from 'supertest';
import { configSchema } from 'librechat-data-provider';
import { createScopedCors } from './cors';

const ALLOWED = 'https://skills.example.com';

/** Stands in for the global `cors()` (no types installed): it sets `*` on every response. */
const globalCors: express.RequestHandler = (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
};

function createApp() {
  const app = express();
  app.use(createScopedCors({ origins: [ALLOWED], fallback: globalCors }));
  app.all('/{*path}', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createScopedCors', () => {
  it('sets credentialed headers instead of the global ones', async () => {
    const res = await request(createApp()).post('/api/auth/refresh').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers.vary).toContain('Origin');
  });

  it('answers the preflight for an allowed origin', async () => {
    const res = await request(createApp())
      .options('/api/skills/import')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('Authorization,Content-Type');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('leaves other origins on the global behaviour', async () => {
    const res = await request(createApp())
      .post('/api/auth/refresh')
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('leaves requests without an Origin on the global behaviour', async () => {
    const res = await request(createApp()).post('/api/auth/refresh');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('leaves unscoped paths on the global behaviour', async () => {
    const res = await request(createApp()).get('/api/convos').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it.each([
    '/api/skillsX',
    '/api/auth/refreshX',
    '/api/auth/refresh/extra',
    '/api/permissions/skillX',
    '/api/permissions/agent/abc',
    '/api/permissions/search-principals',
  ])('does not scope the look-alike %s', async (path) => {
    const res = await request(createApp()).get(path).set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('scopes skill sharing under /api/permissions/skill', async () => {
    const res = await request(createApp()).put('/api/permissions/skill/abc').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('scopes paths under /api/skills', async () => {
    const res = await request(createApp()).get('/api/skills/abc').set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('returns the fallback itself without origins', () => {
    expect(createScopedCors({ origins: [], fallback: globalCors })).toBe(globalCors);
    expect(createScopedCors({ fallback: globalCors })).toBe(globalCors);
  });
});

describe('configSchema corsOrigins', () => {
  const parse = (origins: string[]) => configSchema.shape.corsOrigins.safeParse(origins);

  it.each(['*', 'null', 'https://a.example/path', 'https://a.example/', 'ftp://a.example'])(
    'rejects %s',
    (origin) => {
      expect(parse([origin]).success).toBe(false);
    },
  );

  it.each(['https://skills.sandbox.data.apro.is', 'http://localhost:3000'])(
    'accepts %s',
    (origin) => {
      expect(parse([origin]).success).toBe(true);
    },
  );

  it('defaults to an empty list', () => {
    expect(configSchema.shape.corsOrigins.parse(undefined)).toEqual([]);
  });
});
