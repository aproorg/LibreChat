import type { RequestHandler } from 'express';

/** Paths that may receive credentialed cross-origin calls, matched on segment boundaries. */
const REFRESH_PATH = '/api/auth/refresh';
const PREFIXES = ['/api/skills', '/api/permissions/skill'];

const inScope = (path: string) =>
  path === REFRESH_PATH ||
  PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/**
 * Credentialed CORS for an exact allow-list of origins on the scoped paths only.
 * Every other request goes to `fallback` (the global `cors()`) unchanged. Headers are written
 * by hand rather than adding the `cors` package as a dependency of this workspace.
 */
export function createScopedCors({
  origins,
  fallback,
}: {
  origins?: string[];
  fallback: RequestHandler;
}): RequestHandler {
  if (!origins?.length) {
    return fallback;
  }
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin) || !inScope(req.path)) {
      return fallback(req, res, next);
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.vary('Origin');
    if (req.method !== 'OPTIONS') {
      return next();
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  };
}
