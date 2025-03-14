const { CacheKeys } = require('librechat-data-provider');
const { loadDefaultModels } = require('~/server/services/Config');
const { getLogStores } = require('~/cache');
const {
  BedrockAgentClient,
  ListAgentsCommand,
  ListAgentAliasesCommand,
} = require('@aws-sdk/client-bedrock-agent');
const User = require('~/models/User');

/**
 * @param {ServerRequest} req
 */
const getModelsConfig = async (req) => {
  const cache = getLogStores(CacheKeys.CONFIG_STORE);
  let modelsConfig = await cache.get(CacheKeys.MODELS_CONFIG);
  if (!modelsConfig) {
    modelsConfig = await loadModels(req);
  }

  return modelsConfig;
};

/**
 * Sets the current model selected by the user.
 * @param {string} key - The key of the model to set as current.
 * @returns {Promise<boolean>} Whether the model was set.
 */
async function setCurrentModel(req, label) {
  const cache = getLogStores(CacheKeys.CONFIG_STORE);
  const cachedModelsConfig = await cache.get(CacheKeys.MODELS_CONFIG);
  const agentName = cachedModelsConfig?.find((a) => a.agentName === label)?.agentName;
  if (!agentName) {
    return false;
  }
  console.log('agentName:', agentName); // eslint-disable-line no-console
  await User.findByIdAndUpdate(req.user.id, { lastSelectedModel: agentName }, { new: true });

  return true;
}

async function getCurrentModel(req) {
  const availableAgents = await getModelsConfig(req);
  console.log('availableAgents:', availableAgents); // eslint-disable-line no-console
  const response = await User.findById(req.user.id).select('lastSelectedModel');

  console.log('currentAgentName:', response?.lastSelectedModel); // eslint-disable-line no-console
  let retAgent = {
    agentName: '',
    agentId: '',
    latestAliasId: '',
    description: '',
  };
  availableAgents.forEach((agent) => {
    if (agent.agentName === response?.lastSelectedModel) {
      retAgent = { ...agent };
      return;
    }
  });
  return retAgent;
}

/**
 * Loads the models from the config.
 * @param {ServerRequest} req - The Express request object.
 * @returns {Promise<TModelsConfig>} The models config.
 */
async function loadModels(req) {
  const cache = getLogStores(CacheKeys.CONFIG_STORE);
  const client = new BedrockAgentClient({
    region: process.env.BEDROCK_AWS_DEFAULT_REGION,
  });

  // First request to get agent summaries
  const command = new ListAgentsCommand({});
  const response = await client.send(command);
  const agentSummaries = response.agentSummaries;

  // Second request to get aliases for each agent
  const aliasRequests = agentSummaries.map(async (agent) => {
    const aliasCommand = new ListAgentAliasesCommand({ agentId: agent.agentId });
    const aliasResponse = await client.send(aliasCommand);
    const latestAgent = aliasResponse?.agentAliasSummaries?.reduce((latest, current) =>
      new Date(current.updatedAt) > new Date(latest.updatedAt) ? current : latest,
    );
    return {
      ...agent,
      latestAliasId: latestAgent.agentAliasId,
    };
  });

  // Wait for all alias requests to complete
  const agentsWithAliases = await Promise.all(aliasRequests);
  const agNames = agentsWithAliases.map((a) => a.agentName);
  const defaultModelsConfig = await loadDefaultModels(req);

  const modelConfig = { ...defaultModelsConfig, ...{ bedrock: agNames } };
  await cache.set(CacheKeys.MODELS_CONFIG, agentsWithAliases);
  return modelConfig;
}

async function modelController(req, res) {
  const modelConfig = await loadModels(req);
  res.send(modelConfig);
}

module.exports = { modelController, loadModels, getModelsConfig, setCurrentModel, getCurrentModel };
