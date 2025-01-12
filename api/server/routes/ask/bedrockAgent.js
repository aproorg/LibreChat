const express = require('express');
const { EModelEndpoint } = require('librechat-data-provider');
const { initializeClient } = require('../../services/Endpoints/bedrockAgent/initialize');
const { validateEndpoint, buildEndpointOption, setHeaders } = require('../../middleware');
const { handleAbortError, createAbortController, handleAbort } = require('../../middleware/abortRequest');
const { sendMessage, createOnProgress } = require('~/server/utils');
const { logger } = require('~/config');

const router = express.Router();

router.post(
  '/',
  validateEndpoint,
  buildEndpointOption,
  setHeaders,
  async (req, res) => {
    let { text, generation, conversationId, parentMessageId, overrideParentMessageId } = req.body;
    logger.debug('[/ask/bedrockAgent] Received request:', {
      text,
      conversationId,
      parentMessageId,
      overrideParentMessageId,
      generation,
    });

    const abortController = createAbortController();
    const { onProgress, getPartialText } = createOnProgress();

    res.writeHead(200, {
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });

    try {
      const endpointOption = {
        ...req.body,
        conversationId,
        parentMessageId,
        overrideParentMessageId,
        generation,
      };

      const { client } = await initializeClient({ req, res, endpointOption });

      await sendMessage({
        client,
        message: text,
        conversationId,
        parentMessageId,
        overrideParentMessageId,
        generation,
        onProgress: onProgress.call(null, {
          res,
          text,
          parentMessageId: overrideParentMessageId || parentMessageId,
          conversationId,
        }),
        onAbort: handleAbort(req, res, abortController),
        req,
        res,
        endpointOption,
      });

      logger.debug('[/ask/bedrockAgent] Message sent successfully');
    } catch (error) {
      handleAbortError(res, req, error, {
        partialText: getPartialText(),
        conversationId,
        parentMessageId,
        text,
      });
    }
  },
);

module.exports = router;
