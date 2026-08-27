const { logger } = require('@librechat/data-schemas');
const { withholdEmptyEndpoints } = require('@librechat/api');
const { getEndpointsConfig, getModelsConfig } = require('~/server/services/Config');

/**
 * The one caller that answers "what may this user be offered" — the selector, the
 * Agent Builder and model-spec pruning all derive from this response — so an
 * endpoint with nothing to serve is withheld here and nowhere else. Every other
 * caller of `getEndpointsConfig` wants the endpoint's configuration, and two read
 * keys off it (`defaultParamsEndpoint`, `userProvide`) that withholding removes.
 */
async function endpointController(req, res) {
  const [endpointsConfig, modelsConfig] = await Promise.all([
    getEndpointsConfig(req),
    /* Fail open: an unresolvable models config withholds nothing rather than
       taking down the picker. */
    getModelsConfig(req).catch((error) => {
      logger.error('[endpointController] Could not resolve available models', error);
      return null;
    }),
  ]);

  res.send(JSON.stringify(withholdEmptyEndpoints(endpointsConfig, modelsConfig)));
}

module.exports = endpointController;
