const express = require('express');
const router = express.Router();
const bedrockAgentsRouter = require('./bedrockAgents');
const config = require('../config');

console.log('Mounting bedrockAgents router...');

// Debug middleware to log all requests
router.use((req, res, next) => {
  console.log('Endpoints Router Request:', {
    method: req.method,
    path: req.path,
    baseUrl: req.baseUrl,
    originalUrl: req.originalUrl,
    query: req.query,
    params: req.params
  });
  next();
});

// Mount bedrockAgents routes with debug middleware
router.use('/bedrockAgents', (req, res, next) => {
  console.log('BedrockAgents Router Hit:', {
    method: req.method,
    path: req.path,
    baseUrl: req.baseUrl,
    originalUrl: req.originalUrl
  });
  bedrockAgentsRouter(req, res, next);
});

router.use('/config', config);

// Debug log mounted routes
router.stack.forEach((r) => {
  if (r.route && r.route.path) {
    console.log('Endpoints Route:', r.route.path);
  } else if (r.name === 'router') {
    console.log('Endpoints Router middleware:', r.regexp);
  }
});

module.exports = router;
