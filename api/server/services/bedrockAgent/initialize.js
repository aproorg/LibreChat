const { BedrockAgentRuntimeClient } = require('@aws-sdk/client-bedrock-agent-runtime');
const { EModelEndpoint } = require('librechat-data-provider');

/**
 * Initializes a Bedrock Agent client with the provided configuration.
 *
 * @param {Object} options - Configuration options for the client.
 * @param {Object} options.req - The request object.
 * @param {Object} options.res - The response object.
 * @param {Object} options.endpointOption - Endpoint-specific configuration.
 * @returns {Promise<Object>} The initialized client instance.
 */
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

  return { client };
};

module.exports = initializeClient;
