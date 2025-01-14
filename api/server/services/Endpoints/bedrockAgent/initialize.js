const { BedrockAgentRuntimeClient } = require('@aws-sdk/client-bedrock-agent-runtime');
const { EModelEndpoint } = require('librechat-data-provider');
const { runBedrockAgent } = require('~/server/services/bedrockAgent/bedrockAgentService');

const initializeClient = async ({ req, res, endpointOption }) => {
  const {
    AWS_REGION,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
  } = process.env;

  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials not configured');
  }

  const client = new BedrockAgentRuntimeClient({
    region: AWS_REGION || endpointOption.region || 'us-east-1',
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  client.req = req;
  client.res = res;
  client.options = endpointOption;

  client.sendMessage = async (text, messageOptions) => {
    const { conversationId, messageId: responseMessageId, parentMessageId } = messageOptions;

    return runBedrockAgent({
      client,
      agentId: endpointOption.agentId,
      agentAliasId: endpointOption.agentAliasId,
      sessionId: `session-${Date.now()}`,
      inputText: text,
      messageId: responseMessageId,
      conversationId,
      parentMessageId,
    });
  };

  return { client };
};

module.exports = initializeClient;
