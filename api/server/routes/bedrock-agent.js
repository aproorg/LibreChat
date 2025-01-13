const express = require('express');
const { listBedrockAgentsHandler } = require('../services/Endpoints/bedrockAgent/list');
const { logger } = require('../../config');

const router = express.Router();

// Debug middleware to log all requests
router.use((req, res, next) => {
  logger.debug('[BedrockAgent Router] Incoming request:', {
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.body,
    headers: {
      ...req.headers,
      authorization: req.headers.authorization ? '[REDACTED]' : undefined
    }
  });
  next();
});

// List available Bedrock agents
router.get('/list', listBedrockAgentsHandler);

module.exports = router;
