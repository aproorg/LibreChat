const { createModelsService } = require('@librechat/api');
const {
  config,
  getAppConfig,
  loadDefaultModels,
  loadConfigModels,
  loadAsyncEndpoints,
} = require('~/server/services/Config');

const modelService = createModelsService({
  getAppConfig,
  loadDefaultModels,
  loadConfigModels,
  loadAsyncEndpoints,
  defaultEndpointsConfig: config,
});

/* Keep the full catalog memo shared by endpoints and model validation. */
const { getModelsConfig } = require('~/server/services/Config');

module.exports = { ...modelService, getModelsConfig };
