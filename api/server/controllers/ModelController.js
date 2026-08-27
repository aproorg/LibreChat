const { logger } = require('@librechat/data-schemas');
const { getModelsConfig } = require('~/server/services/Config');

/** Retained as the pre-memo name for this accessor; nothing in-tree uses it. */
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
