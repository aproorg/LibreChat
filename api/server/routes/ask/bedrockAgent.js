const express = require('express');
const crypto = require('crypto');
const { EModelEndpoint } = require('librechat-data-provider');
const { initializeClient } = require('../../services/Endpoints/bedrockAgent/initialize');
const { validateEndpoint, buildEndpointOption, setHeaders } = require('../../middleware');
const { handleAbortError, createAbortController, handleAbort } = require('../../middleware/abortRequest');
const { saveMessage, saveConvo, getConvoTitle } = require('~/models');
const { sendMessage, createOnProgress } = require('~/server/utils');
const { logger } = require('~/config');

const router = express.Router();

router.post(
  '/',
  (req, res, next) => {
    logger.debug('[BedrockAgent] Pre-validation request:', {
      method: req.method,
      path: req.path,
      url: req.url,
      baseUrl: req.baseUrl,
      body: {
        endpoint: req.body?.endpoint,
        agentId: req.body?.agentId,
        text: req.body?.text
      }
    });
    next();
  },
  validateEndpoint,
  buildEndpointOption,
  setHeaders,
  async (req, res) => {
    try {
      const { text, conversationId: _conversationId, parentMessageId, overrideParentMessageId } = req.body;
      const generation = req.body.generation ?? '';
      const conversationId = _conversationId === 'new' ? crypto.randomUUID() : (_conversationId ?? crypto.randomUUID());
      
      logger.debug('[BedrockAgent] Request parameters:', {
        text,
        conversationId,
        parentMessageId,
        overrideParentMessageId,
        generation,
        body: {
          ...req.body,
          agentId: req.body.agentId,
          agentAliasId: req.body.agentAliasId,
          region: req.body.region
        }
      });

      if (!text) {
        throw new Error('Message text is required');
      }

      // Ensure we have a valid conversation ID
      if (!conversationId) {
        throw new Error('Conversation ID is required');
      }

      logger.debug('[/ask/bedrockAgent] Received request:', {
        text,
        conversationId,
        parentMessageId,
        overrideParentMessageId,
        generation,
        headers: req.headers,
        method: req.method,
        path: req.path,
        query: req.query,
        params: req.params,
        body: {
          ...req.body,
          agentId: req.body.agentId,
          agentAliasId: req.body.agentAliasId,
          region: req.body.region,
          model: req.body.model,
          endpoint: req.body.endpoint,
          endpointType: req.body.endpointType,
          conversation: req.body.conversation
        }
      });

      const abortController = createAbortController();
      const { onProgress, getPartialText } = createOnProgress();

      res.writeHead(200, {
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });

      const endpointOption = {
        ...req.body,
        conversationId,
        parentMessageId,
        overrideParentMessageId,
        generation: generation || '',  // Ensure generation has a default value
        agentId: req.body.agentId,
        agentAliasId: req.body.agentAliasId || 'TSTALIASID',
        region: req.body.region || process.env.AWS_REGION || 'eu-central-1',
        sessionId: conversationId // Use conversation ID as session ID for continuity
      };

      logger.debug('[/ask/bedrockAgent] Initializing client with options:', {
        agentId: endpointOption.agentId,
        agentAliasId: endpointOption.agentAliasId,
        region: endpointOption.region,
        model: endpointOption.model,
        endpoint: endpointOption.endpoint,
        endpointType: endpointOption.endpointType
      });

      const { client } = await initializeClient({ req, res, endpointOption });

      // Generate message IDs
      const userMessageId = crypto.randomUUID();
      const responseMessageId = crypto.randomUUID();

      logger.debug('[BedrockAgent] Saving user message:', {
        messageId: userMessageId,
        conversationId,
        text,
        user: req.user?.id
      });
      
      // Initialize conversation if needed
      let finalConversationId = conversationId;
      if (!finalConversationId || finalConversationId === 'new') {
        finalConversationId = crypto.randomUUID();
        logger.debug('[BedrockAgent] Created new conversation:', { finalConversationId });
      }

      // Save the user message first with proper metadata
      try {
        logger.debug('[BedrockAgent] Saving user message:', {
          messageId: userMessageId,
          conversationId,
          parentMessageId,
          text
        });

        const userMessage = await saveMessage(req, {
          messageId: userMessageId,
          conversationId: finalConversationId,
          parentMessageId: parentMessageId || null,
          sender: 'User',
          text,
          isCreatedByUser: true,
          error: false,
          metadata: {
            endpoint: EModelEndpoint.bedrockAgent,
            model: 'bedrock-agent',
            agentId: endpointOption.agentId,
            agentAliasId: endpointOption.agentAliasId,
            region: endpointOption.region
          }
        });

        logger.debug('[BedrockAgent] User message saved successfully:', {
          messageId: userMessage.messageId,
          conversationId: userMessage.conversationId
        });

        // Save initial conversation
        await saveConvo(req, {
          conversationId: finalConversationId,
          model: 'bedrock-agent',
          endpoint: EModelEndpoint.bedrockAgent,
          agentId: endpointOption.agentId,
          agentAliasId: endpointOption.agentAliasId,
          region: endpointOption.region,
          messages: [userMessage],
          title: 'New Conversation'
        });

        logger.debug('[BedrockAgent] Initial conversation saved:', { conversationId });
      } catch (error) {
        logger.error('[BedrockAgent] Error saving message:', {
          error: error.message,
          stack: error.stack,
          messageId: userMessageId,
          conversationId
        });
        throw error;
      }

      logger.debug('[/ask/bedrockAgent] User message saved:', {
        messageId: userMessageId,
        conversationId,
        parentMessageId
      });

      // Set up SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      // Save initial message state
      const initialMessage = {
        messageId: responseMessageId,
        conversationId,
        parentMessageId: userMessageId,
        sender: 'Assistant',
        text: '',
        isCreatedByUser: false,
        error: false,
        endpoint: EModelEndpoint.bedrockAgent,
        model: 'bedrock-agent',
        metadata: {
          agentId: endpointOption.agentId,
          agentAliasId: endpointOption.agentAliasId,
          region: endpointOption.region
        }
      };

      // Save initial assistant message
      await saveMessage(req, initialMessage);

      // Send initial event with message IDs
      const initialEvent = {
        type: 'message',
        message: initialMessage,
        created: Date.now(),
        done: false,
        final: false
      };
      
      logger.debug('[BedrockAgent] Sending initial event:', {
        messageId: responseMessageId,
        conversationId,
        parentMessageId: userMessageId
      });
      
      res.write(`data: ${JSON.stringify(initialEvent)}\n\n`);

      // Send message and get response
      const response = await sendMessage({
        client,
        message: text,
        conversationId,
        parentMessageId: userMessageId,
        messageId: responseMessageId,
        overrideParentMessageId,
        generation,
        onProgress: async (event) => {
          try {
            logger.debug('[BedrockAgent] Progress event:', {
              type: event.type,
              messageId: event.message?.messageId,
              done: event.done,
              final: event.final,
              text: event.message?.text?.substring(0, 50)
            });

            // Ensure message IDs and metadata are consistent
            if (event.message) {
              event.message = {
                ...event.message,
                messageId: responseMessageId,
                parentMessageId: userMessageId,
                conversationId,
                sender: 'Assistant',
                isCreatedByUser: false,
                error: false,
                endpoint: EModelEndpoint.bedrockAgent,
                model: 'bedrock-agent',
                agentId: endpointOption.agentId,
                agentAliasId: endpointOption.agentAliasId,
                region: endpointOption.region,
                metadata: {
                  endpoint: EModelEndpoint.bedrockAgent,
                  model: 'bedrock-agent',
                  agentId: endpointOption.agentId,
                  agentAliasId: endpointOption.agentAliasId,
                  region: endpointOption.region
                }
              };
              
              // Update message in database
              await saveMessage(req, event.message);
            }

            const eventString = JSON.stringify(event);
            res.write(`data: ${eventString}\n\n`);
            
            // Send [DONE] event when the response is complete
            if (event.type === 'message' && event.done && event.final) {
              logger.debug('[BedrockAgent] Sending DONE event');
              res.write('data: [DONE]\n\n');
            }
          } catch (error) {
            logger.error('[BedrockAgent] Error in progress callback:', {
              error: error.message,
              stack: error.stack,
              event
            });
          }
        },
        onAbort: handleAbort(req, res, abortController),
        req,
        res,
        endpointOption,
      });

      // Save the assistant's response with complete metadata
      const title = await getConvoTitle(text);
      
      // Save assistant message
      await saveMessage(req, {
        messageId: responseMessageId,
        conversationId,
        parentMessageId: userMessageId,
        sender: 'Assistant',
        text: response.text || '',
        isCreatedByUser: false,
        error: false,
        metadata: {
          endpoint: EModelEndpoint.bedrockAgent,
          model: 'bedrock-agent',
          agentId: endpointOption.agentId,
          agentAliasId: endpointOption.agentAliasId,
          region: endpointOption.region
        }
      });

      // Save conversation
      await saveConvo(req, { 
        ...response, 
        title,
        messageId: responseMessageId,
        parentMessageId: userMessageId,
        conversationId,
        endpoint: EModelEndpoint.bedrockAgent,
        model: 'bedrock-agent',
        agentId: endpointOption.agentId,
        agentAliasId: endpointOption.agentAliasId,
        region: endpointOption.region,
        metadata: {
          endpoint: EModelEndpoint.bedrockAgent,
          model: 'bedrock-agent',
          agentId: endpointOption.agentId,
          agentAliasId: endpointOption.agentAliasId,
          region: endpointOption.region
        }
      }, { context: 'bedrockAgent' });

      logger.debug('[/ask/bedrockAgent] Message sent and saved successfully:', {
        conversationId,
        responseMessageId: response?.messageId
      });
    } catch (error) {
      logger.error('[/ask/bedrockAgent] Error in request:', {
        error: error.message,
        stack: error.stack,
        requestBody: {
          ...req.body,
          agentId: req.body.agentId,
          region: req.body.region
        }
      });

      // Ensure we have a valid conversationId even in error cases
      const errorConversationId = req.body?.conversationId || `error-${Date.now()}`;
      
      handleAbortError(res, req, error, {
        partialText: '', // No partial text in error case
        conversationId: errorConversationId,
        parentMessageId: req.body?.parentMessageId,
        text: req.body?.text,
      });
    }
  }
);

module.exports = router;
