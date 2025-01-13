const { removeNullishValues } = require('librechat-data-provider');
const generateArtifactsPrompt = require('~/app/clients/prompts/artifacts');
const { logger } = require('~/config');

const buildOptions = (endpoint, parsedBody) => {
  const {
    modelLabel: name,
    promptPrefix,
    maxContextTokens,
    resendFiles = true,
    imageDetail,
    iconURL,
    greeting,
    spec,
    artifacts,
    agentId,
    agentAliasId,
    region,
    ...model_parameters
  } = parsedBody;

  if (!agentId) {
    logger.error('[BedrockAgent] Missing agent ID in parsedBody:', {
      parsedBody,
      agentId,
      agentAliasId,
      region,
      envAgentId: process.env.AWS_BEDROCK_AGENT_ID
    });
    throw new Error('Agent ID is required');
  }

  logger.debug('[BedrockAgent] Building endpoint options with:', {
    agentId,
    agentAliasId,
    region,
    model: 'bedrock-agent',
    parsedBody
  });

  logger.debug('[BedrockAgent] Building endpoint options:', {
    agentId,
    agentAliasId,
    region,
    model: 'bedrock-agent'
  });

  const endpointOption = removeNullishValues({
    endpoint,
    name,
    resendFiles,
    imageDetail,
    iconURL,
    greeting,
    spec,
    promptPrefix,
    maxContextTokens,
    agentId,
    agentAliasId,
    region: region || process.env.AWS_REGION || 'eu-central-1',
    model: 'bedrock-agent',
    model_parameters,
  });

  if (typeof artifacts === 'string') {
    endpointOption.artifactsPrompt = generateArtifactsPrompt({ endpoint, artifacts });
  }

  return endpointOption;
};

module.exports = { buildOptions };
