/**
 * The lane's database. By default an in-memory database with added latency, so serial
 * reads fail the budget. With a URI, a clone of the target engine, which has real latency.
 * The lane seeds a conversation (`load.spec.ts`), so only point the URI at a clone.
 */
function lighthouseDatabaseEnv(uri) {
  if (!uri) {
    return { E2E_USE_MEMORY_MONGO: 'true', E2E_LATENCY_MONGO_DELAY_MS: '250' };
  }
  return { E2E_USE_MEMORY_MONGO: 'false', MONGO_URI: uri };
}

module.exports = { lighthouseDatabaseEnv };
