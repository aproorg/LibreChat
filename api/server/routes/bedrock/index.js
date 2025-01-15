const express = require('express');
const router = express.Router();
const { BedrockClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock');
const {
  uaParser,
  checkBan,
  requireJwtAuth,
  // concurrentLimiter,
  // messageIpLimiter,
  // messageUserLimiter,
} = require('~/server/middleware');

const chat = require('./chat');

router.use(requireJwtAuth);
router.use(checkBan);
router.use(uaParser);

router.get('/agents', async (req, res) => {
  try {
    const client = new BedrockClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const command = new ListAgentsCommand({});
    const response = await client.send(command);
    
    const agents = response.agentSummaries?.map((agent) => ({
      agentId: agent.agentId,
      agentName: agent.agentName,
      agentAliasId: agent.agentAliasId,
      description: agent.description,
      createdAt: agent.createdTimestamp,
      lastUpdatedAt: agent.lastUpdatedTimestamp,
    })) ?? [];

    res.json(agents);
  } catch (error) {
    console.error('Error fetching Bedrock agents:', error);
    res.status(500).json({ error: 'Failed to fetch Bedrock agents' });
  }
});

router.use('/chat', chat);

module.exports = router;
