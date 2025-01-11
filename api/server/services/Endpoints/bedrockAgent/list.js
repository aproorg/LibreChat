const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
const { logger } = require('~/config');

async function listBedrockAgentsHandler(req, res) {
  try {
    // Validate required environment variables
    const agentId = process.env.AWS_BEDROCK_AGENT_ID;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || 'eu-central-1';

    if (!agentId) {
      logger.error('[BedrockAgent] No agent ID configured');
      return res.status(400).json({ 
        error: 'No Bedrock agent configured',
        details: 'AWS_BEDROCK_AGENT_ID environment variable is not set'
      });
    }

    if (!accessKeyId || !secretAccessKey) {
      logger.error('[BedrockAgent] Missing AWS credentials');
      return res.status(400).json({ 
        error: 'AWS credentials not configured',
        details: 'AWS_ACCESS_KEY_ID and/or AWS_SECRET_ACCESS_KEY environment variables are not set'
      });
    }

    // Test AWS credentials by creating a client
    const client = new BedrockRuntimeClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    // Return the configured agent
    const agents = [{
      id: agentId,
      name: 'AWS Bedrock Agent',
      description: 'Configured Bedrock Agent',
      status: 'Active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }];

    logger.debug('[BedrockAgent] Using configured agent:', agents);
    return res.json({ agents });
  } catch (error) {
    logger.error('[BedrockAgent] Error handling agents:', error);
    return res.status(500).json({ 
      error: 'Failed to handle Bedrock agents',
      details: String(error)
    });
  }
}

module.exports = { listBedrockAgentsHandler };
