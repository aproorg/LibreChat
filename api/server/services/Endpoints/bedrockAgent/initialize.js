const { BedrockAgentClient } = require('../../../../app/clients');
const {
  EModelEndpoint,
  getResponseSender,
} = require('librechat-data-provider');
const { logger } = require('../../../../config');

const initializeClient = async ({ req, res, endpointOption }) => {
  logger.debug('[BedrockAgent] Initializing client with options:', JSON.stringify(endpointOption, null, 2));
  
  if (!endpointOption) {
    throw new Error('Endpoint option not provided');
  }

  const sender = endpointOption.name ?? getResponseSender({
    ...endpointOption,
    model: endpointOption.model_parameters?.model,
  });

  const client = new BedrockAgentClient(null, {
    req,
    res,
    ...endpointOption,
    sender,
    endpoint: EModelEndpoint.bedrockAgent,
    agentId: endpointOption.agentId,
    agentAliasId: endpointOption.agentAliasId || process.env.AWS_BEDROCK_AGENT_ALIAS_ID,
    region: endpointOption.region || process.env.AWS_REGION || 'eu-central-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });

  return { client };
};

module.exports = { initializeClient };
