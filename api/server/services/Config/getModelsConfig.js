const loadConfigModels = require('./loadConfigModels');
const loadDefaultModels = require('./loadDefaultModels');

/**
 * Per-request memo of the resolved models config.
 *
 * Serving a single page resolves this several times over — the models route,
 * the startup-config route pruning model specs, the endpoints config deciding
 * which endpoints have anything to serve, model validation on submit, and
 * agent initialization — and every call re-fetches each gateway's catalog. The
 * shared `MODEL_QUERIES` cache cannot absorb it: `fetchModels` deliberately
 * skips that cache whenever an endpoint forwards user-bound headers, since one
 * user's filtered list must never be served to another.
 *
 * Keyed on the request object, so an entry cannot outlive the identity it was
 * resolved for and is collected with the request. Callers share one object —
 * treat the result as read-only.
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

  /* Evict on failure so a later caller in the same request retries rather than
     inheriting a settled rejection. */
  const resolving = resolveModelsConfig(req).catch((error) => {
    inFlight.delete(req);
    throw error;
  });
  inFlight.set(req, resolving);
  return resolving;
}

module.exports = getModelsConfig;
