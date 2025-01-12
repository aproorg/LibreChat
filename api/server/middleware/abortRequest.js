const { logger } = require('~/config');

function createAbortController() {
  return new AbortController();
}

function handleAbort(req, res, abortController) {
  return () => {
    logger.debug('[AbortRequest] Request aborted');
    abortController.abort();
    res.end();
  };
}

function handleAbortError(res, req, error, { partialText, conversationId, parentMessageId, text }) {
  logger.error('[AbortRequest] Error:', error);

  if (error.name === 'AbortError') {
    logger.debug('[AbortRequest] Request aborted');
    return res.end();
  }

  res.write(`event: error\ndata: ${JSON.stringify(error?.message || 'Unknown error')}\n\n`);
  res.end();
}

module.exports = {
  createAbortController,
  handleAbort,
  handleAbortError,
};
