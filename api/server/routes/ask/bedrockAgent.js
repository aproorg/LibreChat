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
  validateEndpoint,
  buildEndpointOption,
  setHeaders,
  async (req, res) => {
    try {
      const { text, conversationId: _conversationId, parentMessageId, overrideParentMessageId } = req.body;
      const generation = req.body.generation ?? '';
      const conversationId = _conversationId ?? crypto.randomUUID();

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

      // Save the user message first with proper metadata
      const userMessage = await saveMessage(req, {
        messageId: parentMessageId,
        conversationId,
        parentMessageId: overrideParentMessageId || null,
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

      logger.debug('[/ask/bedrockAgent] User message saved:', {
        messageId: userMessage.messageId,
        conversationId: userMessage.conversationId
      });

      // Send message and get response
      const response = await sendMessage({
        client,
        message: text,
        conversationId,
        parentMessageId: userMessage.messageId,
        overrideParentMessageId,
        generation,
        onProgress: onProgress.call(null, {
          res,
          text,
          parentMessageId: userMessage.messageId,
          conversationId,
        }),
        onAbort: handleAbort(req, res, abortController),
        req,
        res,
        endpointOption,
      });

      // Save the assistant's response with complete metadata
      const title = await getConvoTitle(text);
      await saveConvo(req, { 
        ...response, 
        title,
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
        conversationId,
        parentMessageId
      });
      handleAbortError(res, req, error, {
        partialText: getPartialText(),
        conversationId,
        parentMessageId,
        text,
      });
    }
  }
);

module.exports = router;
