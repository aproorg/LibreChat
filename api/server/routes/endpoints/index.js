const express = require('express');
const router = express.Router();
const bedrockAgents = require('./bedrockAgents');

router.use('/bedrockAgents', bedrockAgents);

module.exports = router;
