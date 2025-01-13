const { handleError } = require('../utils');

function validateEndpoint(req, res, next) {
  const { endpoint: _endpoint, endpointType } = req.body;
  const endpoint = endpointType ?? _endpoint;

  if (!req.body.text || req.body.text.length === 0) {
    return handleError(res, { text: 'Prompt empty or too short' });
  }

  const pathEndpoint = req.baseUrl.split('/')[3];

  if (endpoint !== pathEndpoint) {
    return handleError(res, { text: 'Illegal request: Endpoint mismatch' });
  }

  if (endpoint === 'bedrockAgent') {
    console.debug('[BedrockAgent] Request body in validateEndpoint:', {
      endpoint,
      agentId: req.body.agentId,
      agentAliasId: req.body.agentAliasId,
      region: req.body.region,
      text: req.body.text,
      model: req.body.model,
      conversation: req.body.conversation
    });
  }

  next();
}

module.exports = validateEndpoint;
