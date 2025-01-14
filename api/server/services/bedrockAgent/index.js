const { initializeBedrockAgentClient, runBedrockAgent } = require('./bedrockAgentService');

module.exports = {
  initializeClient: initializeBedrockAgentClient,
  runBedrockAgent,
};
