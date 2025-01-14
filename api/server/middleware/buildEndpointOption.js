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
      const { conversation = {}, endpointOption = {} } = req.body;
      
      logger.debug('[BedrockAgent] Request body:', {
        conversation,
        endpointOption,
        bodyAgentId: req.body.agentId,
        bodyConversation: req.body.conversation,
        conversationId: req.body.conversationId,
        sessionId: req.body.sessionId
      });
      
      // Get models config first
      const modelsConfig = await getModelsConfig(req);
      const bedrockConfig = modelsConfig?.bedrockAgent?.[0] ?? {};
      
      logger.debug('[BedrockAgent] Config sources:', {
        modelsConfig: !!modelsConfig,
        bedrockConfig,
        envAgentId: process.env.AWS_BEDROCK_AGENT_ID
      });

      // Ensure conversationId is set
      const conversationId = req.body.conversationId || `session-${Date.now()}`;
      
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

      logger.debug('[BedrockAgent] Building endpoint options:', {
        agentId,
        agentAliasId,
        region,
        endpoint,
        endpointType: req.body.endpointType,
        model: 'bedrock-agent',
        conversationId,
        sessionId: conversationId
      });

      // Ensure we have a valid agent ID
      if (!agentId) {
        logger.error('[BedrockAgent] No agent ID found in request or configuration');
        throw new Error('Agent ID is required');
      }

      parsedBody = {
        endpoint: EModelEndpoint.bedrockAgent,
        endpointType: EModelEndpoint.bedrockAgent,
        model: 'bedrock-agent',
        agentId,
        agentAliasId,
        region,
        text: req.body.text || '',
        conversationId,
        parentMessageId: req.body.parentMessageId,
        overrideParentMessageId: req.body.overrideParentMessageId,
        modelDisplayLabel: bedrockConfig.modelDisplayLabel || 'AWS Bedrock Agent',
        conversation: {
          agentId,
          agentAliasId,
          model: 'bedrock-agent',
          endpoint: EModelEndpoint.bedrockAgent,
          endpointType: EModelEndpoint.bedrockAgent,
          region,
          conversationId
        },
        // Add AWS configuration
        aws: {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
          region,
        },
        sessionId: conversationId, // Use conversationId as sessionId for consistency
        enableTrace: true
      };

      logger.debug('[BedrockAgent] Final parsed body:', {
        endpoint,
        endpointType,
        agentId: parsedBody.agentId,
        agentAliasId: parsedBody.agentAliasId,
        region: parsedBody.region,
        model: parsedBody.model
      });
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
    
    logger.debug('[buildEndpointOption] Using builder function for endpoint:', {
      endpoint,
      endpointType,
      isAgents,
      hasEndpointFn: !!endpointFn,
      parsedBody: {
        ...parsedBody,
        agentId: parsedBody.agentId,
        agentAliasId: parsedBody.agentAliasId,
        region: parsedBody.region
      }
    });
    
    // Additional validation for Bedrock Agent
    if (endpoint === EModelEndpoint.bedrockAgent) {
      // Get agent ID from all possible sources
      const agentId = parsedBody.agentId || 
                     parsedBody.conversation?.agentId || 
                     req.body.agentId || 
                     req.body.conversation?.agentId || 
                     process.env.AWS_BEDROCK_AGENT_ID;

      logger.debug('[buildEndpointOption] Agent ID sources:', {
        parsedBodyAgentId: parsedBody.agentId,
        parsedBodyConvoAgentId: parsedBody.conversation?.agentId,
        reqBodyAgentId: req.body.agentId,
        reqBodyConvoAgentId: req.body.conversation?.agentId,
        envAgentId: process.env.AWS_BEDROCK_AGENT_ID,
        selectedAgentId: agentId
      });

      if (!agentId) {
        logger.error('[buildEndpointOption] Missing agent ID for Bedrock Agent request');
        throw new Error('Agent ID is required for Bedrock Agent requests');
      }

      // Update parsedBody with complete agent configuration
      parsedBody.agentId = agentId;
      parsedBody.agentAliasId = parsedBody.agentAliasId || 
                               parsedBody.conversation?.agentAliasId || 
                               req.body.agentAliasId || 
                               'TSTALIASID';
      parsedBody.region = parsedBody.region || 
                         process.env.AWS_REGION || 
                         'eu-central-1';
      parsedBody.model = 'bedrock-agent';
      parsedBody.endpoint = EModelEndpoint.bedrockAgent;
      parsedBody.endpointType = EModelEndpoint.bedrockAgent;

      // Ensure conversation object is properly configured
      parsedBody.conversation = {
        ...(parsedBody.conversation || {}),
        agentId,
        agentAliasId: parsedBody.agentAliasId,
        model: 'bedrock-agent',
        endpoint: EModelEndpoint.bedrockAgent,
        endpointType: EModelEndpoint.bedrockAgent,
        region: parsedBody.region
      };

      logger.debug('[buildEndpointOption] Final configuration:', {
        agentId: parsedBody.agentId,
        agentAliasId: parsedBody.agentAliasId,
        region: parsedBody.region,
        model: parsedBody.model,
        endpoint: parsedBody.endpoint
      });
    }
    
    const builder = isAgents ? (...args) => endpointFn(req, ...args) : endpointFn;

    // Ensure generation is initialized for Bedrock Agent
    if (endpoint === EModelEndpoint.bedrockAgent && !parsedBody.generation) {
      parsedBody.generation = '';
    }

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
