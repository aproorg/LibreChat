const { BedrockAgentRuntimeClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { logger } = require('~/config');

async function listBedrockAgentsHandler(req, res) {
  try {
    const client = new BedrockAgentRuntimeClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const command = new ListAgentsCommand({});
    const response = await client.send(command);
    
    if (!response.agentSummaries) {
      return res.json({ agents: [] });
    }

    const agents = response.agentSummaries.map(agent => ({
      id: agent.agentId,
      name: agent.agentName,
      description: agent.agentDescription || '',
      status: agent.agentStatus,
      createdAt: agent.creationDateTime,
      updatedAt: agent.lastUpdatedDateTime,
    }));

    logger.debug('[BedrockAgent] Successfully fetched agents:', agents);
    return res.json({ agents });
  } catch (error) {
    logger.error('[BedrockAgent] Error fetching agents:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch Bedrock agents',
      details: String(error)
    });
  }
}

module.exports = { listBedrockAgentsHandler };
