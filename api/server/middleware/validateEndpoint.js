const { handleError } = require('../utils');
const { logger } = require('~/config');

function validateEndpoint(req, res, next) {
  const { endpoint: _endpoint, endpointType } = req.body;
  const endpoint = endpointType ?? _endpoint;

  if (!req.body.text || req.body.text.length === 0) {
    return handleError(res, { text: 'Prompt empty or too short' });
  }

  const pathEndpoint = req.baseUrl.split('/')[3];

  if (endpoint !== pathEndpoint) {
    return handleError(res, { text: 'Illegal request: Endpoint mismatch' });
  }

  if (endpoint === 'bedrockAgent') {
    logger.debug('[BedrockAgent] Validating request:', {
      endpoint,
      bodyAgentId: req.body.agentId,
      conversationAgentId: req.body.conversation?.agentId,
      endpointOptionAgentId: req.body.endpointOption?.agentId,
      envAgentId: process.env.AWS_BEDROCK_AGENT_ID,
      conversationId: req.body.conversationId
    });

    // Ensure conversationId is set
    if (!req.body.conversationId) {
      req.body.conversationId = `session-${Date.now()}`;
      logger.debug('[BedrockAgent] Generated new conversationId:', req.body.conversationId);
    }

    // Get agent ID from all possible sources
    const agentId = req.body.agentId || 
                   req.body.conversation?.agentId || 
                   req.body.endpointOption?.agentId || 
                   process.env.AWS_BEDROCK_AGENT_ID;

    if (!agentId) {
      logger.error('[BedrockAgent] No agent ID found in request or environment');
      return handleError(res, { 
        text: 'Agent ID is required',
        details: 'No agent ID found in request body, conversation, endpointOption, or environment variables'
      });
    }

    // Set complete configuration
    req.body = {
      ...req.body,
      agentId,
      agentAliasId: req.body.agentAliasId || 
                    req.body.conversation?.agentAliasId || 
                    req.body.endpointOption?.agentAliasId || 
                    'TSTALIASID',
      region: req.body.region || 
              req.body.conversation?.region || 
              req.body.endpointOption?.region || 
              process.env.AWS_REGION || 
              'eu-central-1',
      model: 'bedrock-agent',
      endpoint: 'bedrockAgent',
      endpointType: 'bedrockAgent',
      sessionId: req.body.conversationId // Ensure sessionId is set for BedrockAgent
    };

    logger.debug('[BedrockAgent] Request validated:', {
      agentId: req.body.agentId,
      agentAliasId: req.body.agentAliasId,
      region: req.body.region,
      model: req.body.model,
      conversationId: req.body.conversationId,
      sessionId: req.body.sessionId
    });
  }

  next();
}

module.exports = validateEndpoint;
