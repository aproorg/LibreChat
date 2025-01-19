const express = require('express');
const router = express.Router();
const { BedrockAgentClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentRuntimeClient } = require('@aws-sdk/client-bedrock-agent-runtime');
const { getResponseSender } = require('librechat-data-provider');
const { initializeClient } = require('~/server/services/Endpoints/bedrockAgents/initializeAgents');

// Configuration validation and setup
class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function validateConfig() {
  const requiredEnvVars = ['BEDROCK_AWS_DEFAULT_REGION', 'BEDROCK_AWS_ACCESS_KEY_ID', 'BEDROCK_AWS_SECRET_ACCESS_KEY'];
  const missing = requiredEnvVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new ConfigurationError(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    region: process.env.BEDROCK_AWS_DEFAULT_REGION,
    credentials: {
      accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
    },
  };
}

router.get('/models', async (req, res) => {
  try {
    const config = validateConfig();
    console.log('Fetching Bedrock agents with validated config:', {
      region: config.region,
      hasAccessKey: !!config.credentials.accessKeyId,
      hasSecretKey: !!config.credentials.secretAccessKey,
    });

    const client = new BedrockAgentClient(config);
    console.log('BedrockAgentClient initialized');

    const command = new ListAgentsCommand({});
    console.log('Sending ListAgentsCommand...');
    const response = await client.send(command);

    if (!response.agentSummaries) {
      throw new Error('No agents found in response');
    }

    const agents = response.agentSummaries.map((agent) => ({
      id: agent.agentId,
      name: agent.agentName,
    }));

    console.log('Successfully mapped agents:', agents);
    res.json(agents);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error('Configuration Error:', error.message);
      res.status(400).json({ error: error.message });
    } else {
      console.error('Error fetching Bedrock agents:', {
        name: error.name,
        message: error.message,
        code: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
        stack: error.stack,
      });
      res.status(500).json({ error: 'Failed to fetch Bedrock agents: ' + error.message });
    }
  }
});

router.post('/chat', async (req, res) => {
  try {
    console.log('POST /chat - Processing chat request...');
    const { text: inputText, messages, parentMessageId, conversationId, model } = req.body;
    
    console.log('Received request:', {
      model,
      text: inputText,
      messageCount: messages?.length,
      conversationId,
      parentMessageId
    });

    if (!model || model === 'Select Agent') {
      throw new Error('No agent ID provided. Please select an agent first.');
    }

    // Handle both direct text and messages array
    let messageText = inputText;
    if (!messageText && messages && Array.isArray(messages)) {
      const lastMessage = messages[messages.length - 1];
      if (typeof lastMessage === 'string') {
        messageText = lastMessage;
      } else if (lastMessage && typeof lastMessage === 'object') {
        if (lastMessage.content && Array.isArray(lastMessage.content)) {
          messageText = lastMessage.content
            .map(c => {
              if (typeof c === 'string') return c;
              if (c && typeof c === 'object') {
                if (c.text?.value) return c.text.value;
                if (c.content) return c.content;
              }
              return '';
            })
            .join(' ');
        } else {
          messageText = lastMessage.text || lastMessage.content;
        }
      }
    }

    if (!messageText) {
      throw new Error('No message text found in request');
    }

    console.log('Chat request details:', {
      agentId: model,
      conversationId,
      messageLength: messageText.length,
      totalMessages: messages?.length,
      hasCredentials: !!process.env.BEDROCK_AWS_ACCESS_KEY_ID && !!process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
      region: process.env.BEDROCK_AWS_DEFAULT_REGION,
    });

    const agentClient = await initializeClient({
      req,
      res,
      endpointOption: {
        model_parameters: {
          agentId: model,
          agentAliasId: process.env.AWS_BEDROCK_AGENT_ALIAS_ID,
        },
      },
    });

    const messageData = await agentClient.client.buildMessages(
      messages || [{ text: messageText, isCreatedByUser: true }],
      parentMessageId,
      agentClient.client.getBuildMessagesOptions(),
    );

    const response = await agentClient.client.sendMessage({
      agentId: model,
      agentAliasId: process.env.AWS_BEDROCK_AGENT_ALIAS_ID,
      sessionId: conversationId || `session-${Date.now()}`,
      inputText: messageText
    });

    if (response.text) {
      // Write the response in a format that the client expects
      const chunk = JSON.stringify({
        text: response.text,
        message: response.text,
        type: 'content'
      });
      res.write(`data: ${chunk}\n\n`);
    }

    res.end();
  } catch (error) {
    console.error('Error in Bedrock Agents chat:', {
      name: error.name,
      message: error.message,
      code: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId,
      stack: error.stack,
    });
    const errorMessage = error.message || 'An error occurred while processing your request';
    res.status(500).json({ 
      error: errorMessage,
      code: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined 
    });
  }
});

module.exports = router;
