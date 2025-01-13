const { parseCompactConvo, EModelEndpoint, isAgentsEndpoint } = require('librechat-data-provider');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const azureAssistants = require('~/server/services/Endpoints/azureAssistants');
const assistants = require('~/server/services/Endpoints/assistants');
const gptPlugins = require('~/server/services/Endpoints/gptPlugins');
const { processFiles } = require('~/server/services/Files/process');
const anthropic = require('~/server/services/Endpoints/anthropic');
const bedrock = require('~/server/services/Endpoints/bedrock');
const { logger } = require('~/config');
const bedrockAgent = require('~/server/services/Endpoints/bedrockAgent');
const openAI = require('~/server/services/Endpoints/openAI');
const agents = require('~/server/services/Endpoints/agents');
const custom = require('~/server/services/Endpoints/custom');
const google = require('~/server/services/Endpoints/google');
const { getConvoFiles } = require('~/models/Conversation');
const { handleError } = require('~/server/utils');

const buildFunction = {
  [EModelEndpoint.openAI]: openAI.buildOptions,
  [EModelEndpoint.google]: google.buildOptions,
  [EModelEndpoint.custom]: custom.buildOptions,
  [EModelEndpoint.agents]: agents.buildOptions,
  [EModelEndpoint.bedrock]: bedrock.buildOptions,
  [EModelEndpoint.bedrockAgent]: bedrockAgent.buildOptions,
  [EModelEndpoint.azureOpenAI]: openAI.buildOptions,
  [EModelEndpoint.anthropic]: anthropic.buildOptions,
  [EModelEndpoint.gptPlugins]: gptPlugins.buildOptions,
  [EModelEndpoint.assistants]: assistants.buildOptions,
  [EModelEndpoint.azureAssistants]: azureAssistants.buildOptions,
};

async function buildEndpointOption(req, res, next) {
  const { endpoint, endpointType } = req.body;
  let parsedBody;
  try {
    if (endpoint === EModelEndpoint.bedrockAgent) {
      // For Bedrock Agent, ensure we preserve the original request body fields
      const { conversation = {}, endpointOption = {} } = req.body;
      
      // Get models config first
      const modelsConfig = await getModelsConfig(req);
      const bedrockConfig = modelsConfig?.bedrockAgent?.[0] ?? {};
      
      // Log all configuration sources
      logger.debug('[BedrockAgent] Configuration sources:', {
        requestBody: {
          agentId: req.body.agentId,
          agentAliasId: req.body.agentAliasId,
          region: req.body.region
        },
        conversation: {
          agentId: conversation?.agentId,
          agentAliasId: conversation?.agentAliasId,
          region: conversation?.region
        },
        endpointOption: {
          agentId: endpointOption?.agentId,
          agentAliasId: endpointOption?.agentAliasId,
          region: endpointOption?.region
        },
        bedrockConfig: {
          agentId: bedrockConfig.agentId,
          agentAliasId: bedrockConfig.agentAliasId,
          region: bedrockConfig.region
        },
        environment: {
          agentId: process.env.AWS_BEDROCK_AGENT_ID,
          region: process.env.AWS_REGION
        }
      });

      // Build configuration with priority order
      const agentId = req.body.agentId || 
                     conversation?.agentId || 
                     endpointOption?.agentId || 
                     bedrockConfig.agentId || 
                     process.env.AWS_BEDROCK_AGENT_ID || 
                     'FZUSVDW4SR';

      const agentAliasId = req.body.agentAliasId || 
                          conversation?.agentAliasId || 
                          endpointOption?.agentAliasId || 
                          bedrockConfig.agentAliasId || 
                          'TSTALIASID';

      const region = req.body.region || 
                    conversation?.region || 
                    endpointOption?.region || 
                    bedrockConfig.region || 
                    process.env.AWS_REGION || 
                    'eu-central-1';

      logger.debug('[BedrockAgent] Selected configuration:', {
        agentId,
        agentAliasId,
        region,
        source: {
          agentId: agentId === req.body.agentId ? 'request' :
                  agentId === conversation?.agentId ? 'conversation' :
                  agentId === endpointOption?.agentId ? 'endpointOption' :
                  agentId === bedrockConfig.agentId ? 'config' :
                  agentId === process.env.AWS_BEDROCK_AGENT_ID ? 'environment' : 'default',
          agentAliasId: agentAliasId === req.body.agentAliasId ? 'request' :
                       agentAliasId === conversation?.agentAliasId ? 'conversation' :
                       agentAliasId === endpointOption?.agentAliasId ? 'endpointOption' :
                       agentAliasId === bedrockConfig.agentAliasId ? 'config' : 'default',
          region: region === req.body.region ? 'request' :
                 region === conversation?.region ? 'conversation' :
                 region === endpointOption?.region ? 'endpointOption' :
                 region === bedrockConfig.region ? 'config' :
                 region === process.env.AWS_REGION ? 'environment' : 'default'
        }
      });

      parsedBody = {
        ...req.body,
        agentId,
        agentAliasId,
        region,
        model: 'bedrock-agent',
        endpoint: EModelEndpoint.bedrockAgent,
        modelDisplayLabel: bedrockConfig.modelDisplayLabel || 'AWS Bedrock Agent'
      };
      
      logger.debug('[BedrockAgent] Building endpoint options:', {
        originalBody: {
          conversationAgentId: conversation?.agentId,
          envAgentId: process.env.AWS_BEDROCK_AGENT_ID,
          agentAliasId: conversation?.agentAliasId,
          region: conversation?.region
        },
        parsedBody: {
          agentId: parsedBody.agentId,
          agentAliasId: parsedBody.agentAliasId,
          region: parsedBody.region
        },
        endpoint,
        endpointType
      });

      if (!parsedBody.agentId) {
        logger.error('[BedrockAgent] No agent ID found in request or environment:', {
          conversationAgentId: conversation?.agentId,
          envAgentId: process.env.AWS_BEDROCK_AGENT_ID
        });
        throw new Error('Agent ID is required');
      }
    } else {
      parsedBody = parseCompactConvo({ endpoint, endpointType, conversation: req.body });
    }
  } catch (error) {
    console.error('[BedrockAgent] Error parsing conversation:', error);
    return handleError(res, { text: 'Error parsing conversation' });
  }

  if (req.app.locals.modelSpecs?.list && req.app.locals.modelSpecs?.enforce) {
    /** @type {{ list: TModelSpec[] }}*/
    const { list } = req.app.locals.modelSpecs;
    const { spec } = parsedBody;

    if (!spec) {
      return handleError(res, { text: 'No model spec selected' });
    }

    const currentModelSpec = list.find((s) => s.name === spec);
    if (!currentModelSpec) {
      return handleError(res, { text: 'Invalid model spec' });
    }

    if (endpoint !== currentModelSpec.preset.endpoint) {
      return handleError(res, { text: 'Model spec mismatch' });
    }

    if (
      currentModelSpec.preset.endpoint !== EModelEndpoint.gptPlugins &&
      currentModelSpec.preset.tools
    ) {
      return handleError(res, {
        text: `Only the "${EModelEndpoint.gptPlugins}" endpoint can have tools defined in the preset`,
      });
    }

    try {
      currentModelSpec.preset.spec = spec;
      if (currentModelSpec.iconURL != null && currentModelSpec.iconURL !== '') {
        currentModelSpec.preset.iconURL = currentModelSpec.iconURL;
      }
      parsedBody = parseCompactConvo({
        endpoint,
        endpointType,
        conversation: currentModelSpec.preset,
      });
    } catch (error) {
      return handleError(res, { text: 'Error parsing model spec' });
    }
  }

  try {
    logger.debug('[buildEndpointOption] Building options for endpoint:', {
      endpoint,
      endpointType,
      bodyEndpoint: req.body.endpoint,
      hasAgentId: !!req.body.agentId,
      hasAliasId: !!req.body.agentAliasId
    });

    const isAgents = isAgentsEndpoint(endpoint);
    const endpointFn = buildFunction[endpointType ?? endpoint];
    
    if (!endpointFn) {
      logger.error('[buildEndpointOption] No builder function found for endpoint:', {
        endpoint,
        endpointType,
        availableEndpoints: Object.keys(buildFunction)
      });
      throw new Error(`No builder function found for endpoint: ${endpoint}`);
    }
    
    const builder = isAgents ? (...args) => endpointFn(req, ...args) : endpointFn;

    // TODO: use object params
    req.body.endpointOption = await builder(endpoint, parsedBody, endpointType);

    // TODO: use `getModelsConfig` only when necessary
    const modelsConfig = await getModelsConfig(req);
    const { resendFiles = true } = req.body.endpointOption;
    req.body.endpointOption.modelsConfig = modelsConfig;
    if (isAgents && resendFiles && req.body.conversationId) {
      const fileIds = await getConvoFiles(req.body.conversationId);
      const requestFiles = req.body.files ?? [];
      if (requestFiles.length || fileIds.length) {
        req.body.endpointOption.attachments = processFiles(requestFiles, fileIds);
      }
    } else if (req.body.files) {
      // hold the promise
      req.body.endpointOption.attachments = processFiles(req.body.files);
    }
    next();
  } catch (error) {
    return handleError(res, { text: 'Error building endpoint option' });
  }
}

module.exports = buildEndpointOption;
