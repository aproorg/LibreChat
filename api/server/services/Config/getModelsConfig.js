const loadConfigModels = require('./loadConfigModels');
const loadDefaultModels = require('./loadDefaultModels');

/**
 * Per-request memo of the resolved models config.
 *
 * Serving one page resolves this from seven places, each re-fetching every
 * gateway's catalog. The shared `MODEL_QUERIES` cache cannot absorb that:
 * `fetchModels` skips it whenever an endpoint forwards user-bound headers, since
 * one user's list must never be served to another. The request is the exact
 * scope that makes the result reusable, and an entry is collected with it.
 *
 * Callers share one object — treat the result as read-only.
 *
 * @type {WeakMap<object, Promise<Record<string, string[]>>>}
 */
const inFlight = new WeakMap();

async function resolveModelsConfig(req) {
  const defaultModelsConfig = await loadDefaultModels(req);
  const customModelsConfig = await loadConfigModels(req);
  return { ...defaultModelsConfig, ...customModelsConfig };
}

/**
 * @param {ServerRequest} req
 * @returns {Promise<Record<string, string[]>>}
 */
function getModelsConfig(req) {
  if (req == null || typeof req !== 'object') {
    return resolveModelsConfig(req);
  }

  const pending = inFlight.get(req);
  if (pending != null) {
    return pending;
  }

  /* Evict on failure so a later caller retries rather than inheriting a
     settled rejection. */
  const resolving = resolveModelsConfig(req).catch((error) => {
    inFlight.delete(req);
    throw error;
  });
  inFlight.set(req, resolving);
  return resolving;
}

module.exports = getModelsConfig;
