const { BedrockAgentClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');
const { logger } = require('../../../../config');

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
      hasSecretKey: !!secretAccessKey,
      accessKeyPrefix: accessKeyId ? accessKeyId.substring(0, 5) + '...' : 'undefined',
      secretKeyPrefix: secretAccessKey ? secretAccessKey.substring(0, 5) + '...' : 'undefined'
    });

    if (!accessKeyId || !secretAccessKey) {
      logger.error('[BedrockAgent] Missing AWS credentials:', {
        hasAccessKey: !!accessKeyId,
        hasSecretKey: !!secretAccessKey,
        region
      });
      throw new Error('AWS credentials not properly configured');
    }

    const client = new BedrockAgentClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    logger.debug('[BedrockAgent] Sending ListAgentsCommand with credentials:', {
      region,
      hasAccessKey: !!accessKeyId,
      hasSecretKey: !!secretAccessKey,
      accessKeyPrefix: accessKeyId ? accessKeyId.substring(0, 5) + '...' : 'undefined'
    });

    // First, check if we have a configured agent ID
    const configuredAgentId = process.env.AWS_BEDROCK_AGENT_ID || 'SLBEYXPT6I';
    
    logger.debug('[BedrockAgent] Checking for configured agent:', {
      configuredAgentId,
      region,
      hasAccessKey: !!accessKeyId,
      hasSecretKey: !!secretAccessKey
    });

    const command = new ListAgentsCommand({});
    
    try {
      const response = await client.send(command);
      
      logger.debug('[BedrockAgent] Raw AWS response:', {
        metadata: response.$metadata,
        agentSummariesCount: response.agentSummaries?.length ?? 0,
        httpStatusCode: response.$metadata?.httpStatusCode,
        requestId: response.$metadata?.requestId,
        hasAgentSummaries: !!response.agentSummaries,
        configuredAgentId,
        rawResponse: JSON.stringify(response, null, 2)
      });

      // Return real agents from AWS Bedrock
      if (!response.agentSummaries) {
        logger.warn('[BedrockAgent] No agent summaries in response:', {
          metadata: response.$metadata,
          responseKeys: Object.keys(response)
        });
        return res.json({ agents: [] });
      }

      const agents = response.agentSummaries.map((agent) => ({
        id: agent.agentId,
        name: agent.agentName || agent.agentId,
        description: agent.description || `Bedrock Agent ${agent.agentId}`,
        status: agent.agentStatus,
        createdAt: agent.creationDateTime?.toISOString() || new Date().toISOString(),
        updatedAt: agent.lastUpdatedDateTime?.toISOString() || new Date().toISOString(),
      }));

      logger.debug('[BedrockAgent] Mapped agents:', {
        count: agents.length,
        agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status }))
      });

      logger.debug('[BedrockAgent] Mapped agents:', {
        count: agents.length,
        agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status }))
      });
      
      return res.json({ agents });
    } catch (error) {
      logger.error('[BedrockAgent] AWS API error:', {
        name: error.name,
        message: error.message,
        code: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
        stack: error.stack,
        credentials: {
          hasAccessKey: !!accessKeyId,
          hasSecretKey: !!secretAccessKey,
          region
        }
      });
      return res.status(500).json({ 
        error: 'Failed to list Bedrock agents',
        details: error.message,
        requestId: error.$metadata?.requestId
      });
    }
  } catch (error) {
    logger.error('[BedrockAgent] Error listing agents:', error);
    return res.status(500).json({ 
      error: 'Failed to list Bedrock agents',
      details: error.message
    });
  }
}

module.exports = { listBedrockAgentsHandler };
