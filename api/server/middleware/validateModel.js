const { handleError } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { ViolationTypes } = require('librechat-data-provider');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getEndpointsConfig } = require('~/server/services/Config');
const { logViolation } = require('~/cache');

const MAX_MODEL_STRING_LENGTH = 256;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$/;

/**
 * Validates the model of the request.
 *
 * @async
 * @param {ServerRequest} req - The Express request object.
 * @param {Express.Response} res - The Express response object.
 * @param {Function} next - The Express next function.
 */
const validateModel = async (req, res, next) => {
  const { endpoint } = req.body;
  const rawModel = req.body.model;

  if (!rawModel || typeof rawModel !== 'string') {
    return handleError(res, { text: 'Model not provided' });
  }

  const model = rawModel.trim();
  if (!model || model.length > MAX_MODEL_STRING_LENGTH || !MODEL_PATTERN.test(model)) {
    return handleError(res, { text: 'Invalid model identifier' });
  }

  req.body.model = model;

  const endpointsConfig = await getEndpointsConfig(req);
  const endpointConfig = endpointsConfig?.[endpoint];

  if (endpointConfig?.userProvide) {
    return next();
  }

  const modelsConfig = await getModelsConfig(req);

  if (!modelsConfig) {
    return handleError(res, { text: 'Models not loaded' });
  }

  const availableModels = modelsConfig[endpoint];
  if (!availableModels) {
    return handleError(res, { text: 'Endpoint models not loaded' });
  }

  let validModel = !!availableModels.find((availableModel) => availableModel === model);

  if (validModel) {
    return next();
  }

  /* An endpoint with no models is unavailable to this request — the gateway
     serves none of what it declares, or none for this user's grants. Any model
     named against it is unserveable rather than illegitimate, and a stored
     conversation or agent pointing at it would otherwise earn its owner a
     violation, and eventually a ban, for a change in configuration. */
  if (availableModels.length === 0) {
    logger.debug(
      `[validateModel] No models available for endpoint "${endpoint}"; rejecting "${model}" without logging a violation`,
    );
    return handleError(res, { text: 'Endpoint unavailable' });
  }

  const { ILLEGAL_MODEL_REQ_SCORE: score = 1 } = process.env ?? {};

  const type = ViolationTypes.ILLEGAL_MODEL_REQUEST;
  const errorMessage = {
    type,
  };

  await logViolation(req, res, type, errorMessage, score);
  return handleError(res, { text: 'Illegal model request' });
};

module.exports = validateModel;
