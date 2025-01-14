const { BedrockAgentClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');
const { logger } = require('../../../../config');

async function listBedrockAgentsHandler(req, res) {
  logger.debug('[BedrockAgent] List handler called');
  try {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION || 'eu-central-1';
    
    logger.debug('[BedrockAgent] Environment check:', {
      hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
      hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION,
      agentId: process.env.AWS_BEDROCK_AGENT_ID
    });

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
      secretKeyPrefix: secretAccessKey ? secretAccessKey.substring(0, 5) + '...' : 'undefined',
      envCheck: {
        AWS_REGION: process.env.AWS_REGION,
        hasAccessKeyEnv: !!process.env.AWS_ACCESS_KEY_ID,
        hasSecretKeyEnv: !!process.env.AWS_SECRET_ACCESS_KEY,
        AWS_BEDROCK_AGENT_ID: process.env.AWS_BEDROCK_AGENT_ID
      }
    });

    const client = new BedrockAgentClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    const configuredAgentId = process.env.AWS_BEDROCK_AGENT_ID || 'FZUSVDW4SR';
    logger.debug('[BedrockAgent] Using configured agent:', { configuredAgentId });

    const listCommand = new ListAgentsCommand({});
    const response = await client.send(listCommand);
    
    logger.debug('[BedrockAgent] Raw response:', {
      metadata: response.$metadata,
      agentCount: response.agentSummaries?.length ?? 0,
      status: response.$metadata?.httpStatusCode,
      requestId: response.$metadata?.requestId,
      configuredAgentId
    });
    
    // Create default agent configuration
    const defaultAgent = {
      id: configuredAgentId,
      name: 'demo',
      description: 'AWS Bedrock Agent',
      status: 'AVAILABLE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Process response and map agents
    let agents = [];
    if (response.agentSummaries && response.agentSummaries.length > 0) {
      agents = response.agentSummaries.map((agent) => ({
        id: agent.agentId,
        name: agent.agentName || 'demo',
        description: agent.description || `AWS Bedrock Agent ${agent.agentId}`,
        status: agent.agentStatus || 'AVAILABLE',
        createdAt: agent.creationDateTime?.toISOString() || new Date().toISOString(),
        updatedAt: agent.lastUpdatedDateTime?.toISOString() || new Date().toISOString(),
      }));

      logger.debug('[BedrockAgent] Found agents:', {
        count: agents.length,
        agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status }))
      });
    } else {
      logger.debug('[BedrockAgent] No agents found, using default agent:', defaultAgent);
      agents = [defaultAgent];
    }

    // Ensure configured agent is included
    const hasConfiguredAgent = agents.some(agent => agent.id === configuredAgentId);
    if (!hasConfiguredAgent) {
      logger.debug('[BedrockAgent] Adding configured agent to list:', configuredAgentId);
      agents.unshift(defaultAgent);
    }

    return res.json({ agents });
  } catch (error) {
    logger.error('[BedrockAgent] Error listing agents:', {
      name: error.name,
      message: error.message,
      code: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId,
      stack: error.stack
    });

    // On error, return the default agent to ensure UI functionality
    logger.debug('[BedrockAgent] Returning default agent due to error');
    return res.json({ 
      agents: [defaultAgent],
      warning: 'Using fallback agent due to listing error'
    });
  }
}

module.exports = { listBedrockAgentsHandler };
