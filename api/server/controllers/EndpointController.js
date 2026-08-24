const { getEndpointsConfig } = require('~/server/services/Config');

async function endpointController(req, res) {
  /**
   * The one caller that answers "what may this user be offered": the selector,
   * the Agent Builder and spec pruning all derive from this response, so an
   * endpoint with nothing to serve is withheld here and nowhere else.
   */
  const endpointsConfig = await getEndpointsConfig(req, { withholdEmpty: true });
  res.send(JSON.stringify(endpointsConfig));
}

module.exports = endpointController;
