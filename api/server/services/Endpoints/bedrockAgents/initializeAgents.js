const { createContentAggregator } = require('@librechat/agents');
const {
  EModelEndpoint,
  providerEndpointMap,
  getResponseSender,
} = require('librechat-data-provider');
const { getDefaultHandlers } = require('~/server/controllers/agents/callbacks');
const getOptions = require('./optionsAgents');
const BedrockAgentsClient = require('./agentClient');
const AgentClient = require('~/server/controllers/agents/client');
const { getModelMaxTokens } = require('~/utils');

const initializeClient = async ({ req, res, endpointOption }) => {
  if (!endpointOption) {
    throw new Error('Endpoint option not provided');
  }

  /** @type {Array<UsageMetadata>} */
  const collectedUsage = [];
  const { contentParts, aggregateContent } = createContentAggregator();
  const eventHandlers = getDefaultHandlers({ res, aggregateContent, collectedUsage });

  /** @type {Agent} */
  const agent = {
    id: EModelEndpoint.bedrockAgents,
    name: "Bedrock Agent",
    instructions: endpointOption.promptPrefix,
    provider: EModelEndpoint.bedrockAgents,
    model: endpointOption.model_parameters.model,
    model_parameters: endpointOption.model_parameters,
  };

  if (typeof endpointOption.artifactsPrompt === 'string' && endpointOption.artifactsPrompt) {
    agent.instructions = `${agent.instructions ?? ''}\n${endpointOption.artifactsPrompt}`.trim();
  }

  // TODO: pass-in override settings that are specific to current run
  const options = await getOptions({
    req,
    res,
    endpointOption,
  });

  agent.model_parameters = Object.assign(agent.model_parameters, options.llmConfig);
  if (options.configOptions) {
    agent.model_parameters.configuration = options.configOptions;
  }

  const sender =
    agent.name ??
    getResponseSender({
      ...endpointOption,
      model: endpointOption.model_parameters.model,
    });

  const config = {
    region: process.env.BEDROCK_AWS_DEFAULT_REGION || process.env.AWS_REGION || 'eu-central-1',
    credentials: {
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    }
  };

  console.log('Initializing BedrockAgentsClient with config:', {
    region: config.region,
    hasAccessKey: !!config.credentials.accessKeyId,
    hasSecretKey: !!config.credentials.secretAccessKey
  });

  const client = new BedrockAgentsClient(config);
  return { client };
};

module.exports = { initializeClient };
