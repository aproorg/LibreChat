const { createEndpointsConfigService } = require('@librechat/api');
const loadDefaultEndpointsConfig = require('./loadDefaultEConfig');
const getModelsConfig = require('./getModelsConfig');
const { getAppConfig } = require('./app');

const { getEndpointsConfig, checkCapability } = createEndpointsConfigService({
  getAppConfig,
  loadDefaultEndpointsConfig,
  // Lets a caller passing `withholdEmpty` drop a custom endpoint with no models
  // available to this request. Memoized per request, so sharing it with the
  // models route, spec pruning and model validation costs no extra catalog
  // fetch.
  getModelsConfig,
});

module.exports = { getEndpointsConfig, checkCapability };
