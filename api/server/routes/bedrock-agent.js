const express = require('express');
const router = express.Router();
const { listBedrockAgentsHandler } = require('../services/Endpoints/bedrockAgent/list');
const { initializeClient } = require('../services/Endpoints/bedrockAgent/initialize');
const { logger } = require('../../config');

router.get('/list', listBedrockAgentsHandler);

router.post('/chat', async (req, res) => {
  try {
    logger.debug('[BedrockAgent] Received chat request:', {
      body: req.body,
      endpoint: req.body?.endpoint,
      model: req.body?.model,
    });
    
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const { client } = await initializeClient({ 
      req, 
      res, 
      endpointOption: req.body 
    });
    
    const { text, conversationId, parentMessageId } = req.body;
    const responseMessageId = Math.random().toString(36).substring(2, 15);

    // Send initial event to set up the message structure
    const initialEvent = {
      type: 'message',
      message: {
        id: responseMessageId,
        role: 'assistant',
        content: '',
        parentMessageId: parentMessageId,
        conversationId: conversationId,
      },
      created: Date.now(),
      model: 'bedrock-agent',
      done: false,
    };
    res.write(`data: ${JSON.stringify(initialEvent)}\n\n`);

    try {
      await client.sendMessage(text, {
        onProgress: (event) => {
          if (event && typeof event === 'object') {
            // Ensure the event is properly formatted
            const formattedEvent = {
              type: 'message',
              message: {
                id: responseMessageId,
                role: 'assistant',
                content: event.message?.content || '',
                parentMessageId: parentMessageId,
                conversationId: conversationId,
              },
              created: Date.now(),
              model: 'bedrock-agent',
              done: false,
            };
            res.write(`data: ${JSON.stringify(formattedEvent)}\n\n`);
          }
        }
      });
      
      // Send completion event
      const completionEvent = {
        type: 'message',
        message: {
          id: responseMessageId,
          role: 'assistant',
          content: text,
          parentMessageId: parentMessageId,
          conversationId: conversationId,
        },
        created: Date.now(),
        model: 'bedrock-agent',
        done: true,
        final: true,
      };
      res.write(`data: ${JSON.stringify(completionEvent)}\n\n`);
      res.write('data: [DONE]\n\n');
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
