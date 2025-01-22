const express = require('express');
const router = express.Router();
const { BedrockAgentClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { getResponseSender } = require('librechat-data-provider');
const { initializeClient } = require('~/server/services/Endpoints/bedrockAgents/initializeAgents');
const { saveMessage, getConvoTitle, saveConvo } = require('~/models');
const { handleError } = require('~/utils');
const passport = require('passport');

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

// Authentication middleware moved to main app.js

router.get('/', async (req, res) => {
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
    res.json({ agents });
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

router.post('/chat', passport.authenticate('jwt', { session: false }), async (req, res) => {
  // Verify user authentication
  if (!req.user) {
    const errorEvent = {
      error: true,
      message: 'User not authenticated'
    };
    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    res.end();
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  try {
    console.log('Authenticated user:', {
      userId: req.user.id,
      email: req.user.email
    });
    console.log('POST /chat - Processing chat request...');
    const { text: inputText, messages, parentMessageId, conversationId: reqConversationId, model } = req.body;
    
    // Ensure we have a valid conversation ID
    if (!reqConversationId || reqConversationId === 'new') {
      throw new Error('Invalid conversation ID. Expected a valid conversation ID but received: ' + reqConversationId);
    }
    const conversationId = reqConversationId;

    // Send initial state event
    const initEvent = {
      type: 'state',
      conversationId,
      messageId: parentMessageId || crypto.randomUUID(),
    };
    res.write(`data: ${JSON.stringify(initEvent)}\n\n`);
    
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

    // Save user message with authenticated user info
    const messageId = crypto.randomUUID();
    const userMessage = {
      messageId,
      conversationId,
      parentMessageId: parentMessageId || messageId,
      sender: 'User',
      text: messageText,
      isCreatedByUser: true,
      error: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await saveMessage(req, userMessage);

    // Initialize conversation if it's new
    if (reqConversationId === 'new' || !reqConversationId) {
      const title = await getConvoTitle(messageText, 'Create a title for this chat');
      await saveConvo({
        user: req.user.id,
        conversationId,
        title,
        endpoint: 'bedrockAgents',
        model,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Send created event for message
    const createdEvent = {
      created: true,
      message: {
        messageId,
        parentMessageId: parentMessageId || messageId,
        conversationId,
        sender: 'User',
        text: messageText,
        isCreatedByUser: true,
      },
    };
    res.write(`data: ${JSON.stringify(createdEvent)}\n\n`);

    const initialMessage = { text: messageText, isCreatedByUser: true };
    const messageData = await agentClient.client.buildMessages(
      messages || [initialMessage],
      parentMessageId || messageId,
      agentClient.client.getBuildMessagesOptions(),
    );

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

    // Send start event
    const startEvent = {
      type: 'start',
      messageId: messageId,
      conversationId,
      model,
      agentId: model,
      parentMessageId: parentMessageId || messageId,
    };
    res.write(`data: ${JSON.stringify(startEvent)}\n\n`);

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

            // Handle both JSON and plain text responses
            if (extractedText) {
              responseText += extractedText;
              
              // Create or update agent message
              const agentMessageId = crypto.randomUUID();
              const agentMessage = {
                messageId: agentMessageId,
                conversationId,
                parentMessageId: messageId,
                sender: 'Bedrock Agent',
                text: responseText, // Use complete response text
                isCreatedByUser: false,
                error: false,
                createdAt: new Date(),
                updatedAt: new Date()
              };

              // Save complete message state
              await saveMessage(req, agentMessage);

              // Send content event for streaming UI update
              const messageEvent = {
                message: extractedText,
                messageId: agentMessageId,
                parentMessageId: messageId,
                conversationId,
                type: 'content'
              };
              res.write(`data: ${JSON.stringify(messageEvent)}\n\n`);
            }
          } catch (err) {
            console.error('Error processing agent response:', err);
            // If JSON parsing fails, treat as raw text
            responseText += decodedResponse;
            const messageEvent = {
              message: decodedResponse,
              messageId: crypto.randomUUID(),
              parentMessageId: messageId,
              conversationId,
              type: 'content'
            };
            res.write(`data: ${JSON.stringify(messageEvent)}\n\n`);
          }
        }
      }

      // Send final event with complete response
      const finalEvent = {
        type: 'done',
        messageId: crypto.randomUUID(),
        parentMessageId: messageId,
        conversationId,
        model,
        agentId: model,
        final: true,
        message: responseText,
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
