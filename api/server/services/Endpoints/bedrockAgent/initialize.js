import { BedrockAgentClient } from '~/app/clients';
import {
  EModelEndpoint,
  getResponseSender,
} from 'librechat-data-provider';
import { logger } from '~/config';

const initializeClient = async ({ req, res, endpointOption }) => {
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
    agentId: process.env.AWS_BEDROCK_AGENT_ID,
    agentAliasId: process.env.AWS_BEDROCK_AGENT_ALIAS_ID,
    region: process.env.AWS_REGION || 'eu-central-1',
  });

  return { client };
};

module.exports = { initializeClient };
