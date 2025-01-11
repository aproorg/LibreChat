const express = require('express');
const router = express.Router();
const { BedrockAgentRuntimeClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { listBedrockAgentsHandler } = require('../services/Endpoints/bedrockAgent/list');
const { initializeClient } = require('../services/Endpoints/bedrockAgent/initialize');
const { logger } = require('../../config');

router.get('/list', listBedrockAgentsHandler);

router.post('/chat', async (req, res) => {
  try {
    const { agentId } = req.body;
    if (!agentId) {
      return res.status(400).json({
        error: 'Agent ID is required',
        code: 'missing_agent_id'
      });
    }

    // Validate agent exists
    const validationClient = new BedrockAgentRuntimeClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    try {
      const command = new ListAgentsCommand({});
      const response = await validationClient.send(command);
      const validAgent = response.agentSummaries?.find(agent => agent.agentId === agentId);
      
      if (!validAgent) {
        return res.status(400).json({
          error: 'Invalid agent ID',
          code: 'invalid_agent_id'
        });
      }
    } catch (error) {
      logger.error('[BedrockAgent] Error validating agent:', error);
      return res.status(500).json({
        error: 'Failed to validate agent ID',
        code: 'agent_validation_error',
        details: error.message
      });
    }

    const debugInfo = {
      body: JSON.stringify(req.body, null, 2),
      endpoint: req.body?.endpoint,
      model: req.body?.model,
      agentId: req.body?.agentId,
      region: process.env.AWS_REGION,
      hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
      hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
      aliasId: req.body?.agentAliasId
    };
    
    console.log('[BedrockAgent] Debug Info:', debugInfo);
    logger.debug('[BedrockAgent] Received chat request:', debugInfo);
    
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const endpointOption = {
      endpoint: req.body?.endpoint,
      model: req.body?.model,
      agentId: req.body?.agentId,
      agentAliasId: req.body?.agentAliasId,
      region: process.env.AWS_REGION || 'eu-central-1',
      text: req.body?.text,
      conversationId: req.body?.conversationId,
      parentMessageId: req.body?.parentMessageId,
      modelDisplayLabel: req.body?.modelDisplayLabel
    };

    logger.debug('[BedrockAgent] Initializing client with options:', {
      ...endpointOption,
      hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
      hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY
    });

    const { client } = await initializeClient({ 
      req, 
      res, 
      endpointOption
    });
    
    const { text, conversationId, parentMessageId } = req.body;
    logger.debug('[BedrockAgent] Processing message:', { text, conversationId, parentMessageId });

    try {
      await client.sendMessage(text, {
        onProgress: (event) => {
          if (!event || typeof event !== 'object') {
            logger.warn('[BedrockAgent] Invalid event received:', event);
            return;
          }

          try {
            logger.debug('[BedrockAgent] Processing event:', event);
            const eventString = JSON.stringify(event);
            logger.debug('[BedrockAgent] Sending SSE event:', eventString);
            res.write(`data: ${eventString}\n\n`);

            // Only send [DONE] event if this is the final message
            if (event.type === 'message' && event.done && event.final) {
              logger.debug('[BedrockAgent] Sending [DONE] event');
              res.write('data: [DONE]\n\n');
            }
          } catch (jsonError) {
            logger.error('[BedrockAgent] Error stringifying event:', jsonError, event);
            const errorEvent = {
              type: 'error',
              error: {
                message: 'Failed to process response',
                code: 'json_error',
                details: String(jsonError),
              },
              created: Date.now(),
            };
            res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          }
        }
      });
      logger.debug('[BedrockAgent] Message completed');
    } catch (error) {
      logger.error('[BedrockAgent] Error in sendMessage:', error);
      const errorEvent = {
        type: 'error',
        error: {
          message: error.message || 'An error occurred',
          code: error.code || 'unknown',
        },
        created: Date.now(),
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    } finally {
      res.end();
    }
  } catch (error) {
    logger.error('[BedrockAgent] Error in chat endpoint:', error);
    // Send error in SSE format
    const errorResponse = {
      type: 'error',
      error: {
        message: error.message,
        code: error.code || 'unknown',
      },
      created: Date.now(),
    };
    res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
    res.end();
  }
});

module.exports = router;
