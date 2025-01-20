const express = require('express');
const router = express.Router();
const { BedrockAgentClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
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
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  try {
    console.log('POST /chat - Processing chat request...');
    const { text: inputText, messages, parentMessageId, conversationId: reqConversationId, model } = req.body;
    const conversationId = reqConversationId || `conv-${Date.now()}`;
    
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

    const initialMessage = { text: messageText, isCreatedByUser: true };
    const messageData = await agentClient.client.buildMessages(
      messages || [initialMessage],
      parentMessageId,
      agentClient.client.getBuildMessagesOptions(),
    );

    // Generate a unique message ID if not present
    const messageId = messageData?.messages?.[messageData.messages.length - 1]?.messageId ?? crypto.randomUUID();

    // Send created event
    const createdEvent = {
      created: true,
      message: {
        messageId,
        parentMessageId,
        conversationId,
      },
    };
    res.write(`data: ${JSON.stringify(createdEvent)}\n\n`);

    const client = new BedrockAgentRuntimeClient({
      region: process.env.BEDROCK_AWS_DEFAULT_REGION,
      credentials: {
        accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
      },
    });

    const command = new InvokeAgentCommand({
      agentId: model,
      agentAliasId: process.env.AWS_BEDROCK_AGENT_ALIAS_ID,
      sessionId: conversationId,
      inputText: messageText
    });

    const response = await client.send(command);

    // Extract text from response, handling different possible response formats
    let responseText = '';
    if (response?.completion) {
      for await (const chunk of response.completion) {
        if (chunk.chunk?.bytes) {
          const decodedResponse = new TextDecoder().decode(chunk.chunk.bytes);
          try {
            const jsonData = JSON.parse(decodedResponse);
            let extractedText = '';
            
            // Try to extract text from various response formats
            if (jsonData.content?.[0]?.text) {
              const match = jsonData.content[0].text.match(/<answer>(.*?)<\/answer>/s);
              extractedText = match ? match[1].trim() : jsonData.content[0].text;
            } else if (jsonData.trace?.orchestrationTrace?.observation?.finalResponse?.text) {
              extractedText = jsonData.trace.orchestrationTrace.observation.finalResponse.text;
            } else if (jsonData.trace?.orchestrationTrace?.modelInvocationOutput?.text) {
              const match = jsonData.trace.orchestrationTrace.modelInvocationOutput.text.match(/<answer>(.*?)<\/answer>/s);
              extractedText = match ? match[1].trim() : jsonData.trace.orchestrationTrace.modelInvocationOutput.text;
            }

            if (extractedText && !extractedText.includes('{') && !extractedText.includes('}')) {
              responseText += extractedText;
              // Send message event with partial response
              const messageEvent = {
                message: extractedText,
                messageId,
                parentMessageId,
                conversationId,
                type: 'content'
              };
              res.write(`data: ${JSON.stringify(messageEvent)}\n\n`);
            }
          } catch (err) {
            // If not JSON or parsing fails, treat as raw text
            if (!decodedResponse.includes('{') && !decodedResponse.includes('}')) {
              responseText += decodedResponse;
              const messageEvent = {
                message: decodedResponse,
                messageId,
                parentMessageId,
                conversationId,
                type: 'content'
              };
              res.write(`data: ${JSON.stringify(messageEvent)}\n\n`);
            }
          }
        }
      }

      // Send final event with complete response
      const finalEvent = {
        final: true,
        message: responseText,
        messageId,
        conversationId,
      };
      res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
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

    // Send error event in SSE format
    const errorEvent = {
      error: true,
      message: error.message || 'An error occurred while processing your request',
      code: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId,
    };
    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    res.end();
  }
});

module.exports = router;
