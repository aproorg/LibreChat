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
    model: 'bedrock-agent',
  });

  const modelOptions = {
    model: 'bedrock-agent',
    ...endpointOption.model_parameters,
  };

  const client = new BedrockAgentClient(null, {
    req,
    res,
    ...endpointOption,
    sender,
    endpoint: EModelEndpoint.bedrockAgent,
    agentId: endpointOption.agentId,
    agentAliasId: endpointOption.agentAliasId,
    region: endpointOption.region || process.env.AWS_REGION || 'eu-central-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    modelOptions,
  });

  return { client };
};

module.exports = { initializeClient };
