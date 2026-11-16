const { createEndpointsConfigService } = require('@librechat/api');
const loadDefaultEndpointsConfig = require('./loadDefaultEConfig');
const { getAppConfig } = require('./app');
const { getAccess } = require('./access');

const { getEndpointsConfig, checkCapability } = createEndpointsConfigService({
  getAppConfig,
  loadDefaultEndpointsConfig,
  getAccess,
});

module.exports = { getEndpointsConfig, checkCapability };
