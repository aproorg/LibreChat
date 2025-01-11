const express = require('express');
const router = express.Router();
const { listBedrockAgentsHandler } = require('../services/Endpoints/bedrockAgent/list');

router.get('/list', listBedrockAgentsHandler);
router.post('/chat', require('../services/Endpoints/bedrockAgent/initialize').initializeClient);

module.exports = router;
