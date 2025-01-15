const express = require('express');
const { logger } = require('~/config');

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
 * @route POST /api/bedrock/chat
 * @desc Chat with Bedrock or Bedrock Agent, supporting both standard Bedrock and Agent endpoints
 * @access Public
 * @param {express.Request} req - The request object containing:
 *   - body.endpointType: 'bedrock' | 'bedrockAgent'
 *   - body.agentId: (optional) AWS Bedrock Agent ID
 *   - body.agentAliasId: (optional) AWS Bedrock Agent Alias ID
 *   - body.prompt: The input text for the agent
 *   - body.sessionId: Unique session identifier
 * @param {express.Response} res - The response object for streaming or JSON responses
 * @param {express.NextFunction} next - Express next middleware function
 * @returns {void}
 * @throws {Error} When required parameters are missing or AWS service fails
 */
router.post(
  '/',
  buildEndpointOption,
  setHeaders,
  async (req, res, next) => {
    try {
      const { endpointType } = req.body;

      if (endpointType === 'bedrockAgent') {
        const {
          agentId,
          agentAliasId,
          prompt,
          sessionId = `session-${Date.now()}`,
        } = req.body;

        if (!prompt) {
          throw new Error('Prompt is required for Bedrock Agent chat');
        }

        const client = initializeAgentClient();
        const options = buildOptions('bedrockAgent', {
          agentId,
          agentAliasId,
          prompt,
          sessionId,
        });

        const command = createAgentCommand({
          agentId: options.agentId,
          agentAliasId: options.agentAliasId,
          sessionId: options.sessionId,
          prompt: options.prompt,
        });

        // Set up SSE headers for streaming response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        try {
          await invokeAgent({
            client,
            command,
            onProgress: (chunk) => {
              res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
            },
          });

          res.write('data: [DONE]\n\n');
          res.end();
        } catch (error) {
          // Handle streaming errors by sending error event
          logger.error('Error in Bedrock Agent streaming:', error);
          res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
          res.end();
        }
      } else {
        const { client } = await initializeClient({ req, res, endpointOption: req.body });
        await client.sendMessage();
      }
    } catch (error) {
      logger.error('Error in Bedrock chat endpoint:', { error, body: req.body });
      res.status(500).json({ error: error.message });
    }
  },
);

module.exports = router;
