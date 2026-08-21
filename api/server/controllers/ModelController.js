const { logger } = require('@librechat/data-schemas');
const { getModelsConfig } = require('~/server/services/Config');

/**
 * The request-memoized accessor is the single entry point for a request's
 * models config; `loadModels` stays exported for callers that predate it.
 */
const loadModels = (req) => getModelsConfig(req);

async function modelController(req, res) {
  try {
    const modelConfig = await getModelsConfig(req);
    res.send(modelConfig);
  } catch (error) {
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, loadModels, getModelsConfig };
