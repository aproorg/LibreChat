const express = require('express');

const router = express.Router();
const {
  setHeaders,
  handleAbort,
  buildEndpointOption,
} = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/bedrock');
const {
  initializeAgentClient,
  createAgentCommand,
  invokeAgent,
} = require('~/server/services/Endpoints/bedrock/agent');
const { buildOptions } = require('~/server/services/Endpoints/bedrock/build');

router.post('/abort', handleAbort());

/**
 * @route POST /
 * @desc Chat with Bedrock or Bedrock Agent
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post(
  '/',
  buildEndpointOption,
  setHeaders,
  async (req, res, next) => {
    try {
      const { endpointType } = req.body;

      if (endpointType === 'bedrockAgent') {
        const client = initializeAgentClient();
        const options = buildOptions(req);
        const command = createAgentCommand(options);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        await invokeAgent({
          client,
          command,
          onProgress: (chunk) => {
            res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
          },
        });

        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const { client } = await initializeClient({ req, res, endpointOption: req.body });
        await client.sendMessage();
      }
    } catch (error) {
      console.error('Error in Bedrock chat endpoint:', error);
      res.status(500).json({ error: error.message });
    }
  },
);

module.exports = router;
