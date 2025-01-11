const { BedrockAgentClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');
const { logger } = require('~/config');

async function listBedrockAgentsHandler(req, res) {
  try {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || 'eu-central-1';

    if (!accessKeyId || !secretAccessKey) {
      logger.error('[BedrockAgent] Missing AWS credentials');
      return res.status(400).json({ 
        error: 'AWS credentials not configured',
        details: 'AWS_ACCESS_KEY_ID and/or AWS_SECRET_ACCESS_KEY environment variables are not set'
      });
    }

    logger.debug('[BedrockAgent] Initializing client with AWS credentials:', {
      region,
      hasAccessKey: !!accessKeyId,
      hasSecretKey: !!secretAccessKey
    });

    const client = new BedrockAgentClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    const command = new ListAgentsCommand({});
    const response = await client.send(command);
    
    const agents = response.agentSummaries?.map((agent) => ({
      id: agent.agentId,
      name: agent.agentName,
      description: agent.description || '',
      status: agent.agentStatus,
      createdAt: agent.creationDateTime?.toISOString(),
      updatedAt: agent.lastUpdatedDateTime?.toISOString(),
    })) || [];

    logger.debug('[BedrockAgent] Found agents:', agents);
    return res.json({ agents });
  } catch (error) {
    logger.error('[BedrockAgent] Error listing agents:', error);
    return res.status(500).json({ 
      error: 'Failed to list Bedrock agents',
      details: error.message
    });
  }
}

module.exports = { listBedrockAgentsHandler };
