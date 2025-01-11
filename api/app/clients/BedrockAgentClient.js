const {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  RetrieveAndGenerateCommand,
} = require('@aws-sdk/client-bedrock-agent-runtime');
const { EModelEndpoint } = require('librechat-data-provider');
const { isEnabled } = require('../../server/utils');
const BaseClient = require('./BaseClient');
const { logger } = require('../../config');

class BedrockAgentClient extends BaseClient {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.sender = options.sender ?? 'Bedrock';
    this.contextStrategy = options.contextStrategy ? options.contextStrategy.toLowerCase() : 'discard';
    this.shouldSummarize = this.contextStrategy === 'summarize';
    
    // Initialize AWS Bedrock Agent client
    this.client = new BedrockAgentRuntimeClient({
      region: options.region || process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: options.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    // Set agent configuration
    this.agentId = options.agentId;
    this.agentAliasId = options.agentAliasId;
    this.sessionId = options.sessionId;
    this.enableTrace = options.enableTrace ?? false;
    this.knowledgeBaseId = options.knowledgeBaseId;
    this.retrievalConfig = {
      retrievalEnabled: !!options.knowledgeBaseId,
      temperature: options.temperature ?? 0.7,
      topK: options.topK ?? 5,
      topP: options.topP ?? 0.9,
    };
  }

  async sendMessage(message, opts = {}) {
    const { user, head, isEdited, conversationId, responseMessageId, saveOptions, userMessage } =
      await this.handleStartMethods(message, opts);

    try {
      const baseInput = {
        agentId: this.agentId,
        agentAliasId: this.agentAliasId,
        sessionId: this.sessionId || conversationId,
        enableTrace: this.enableTrace,
        inputText: message,
      };

      let command;
      if (this.retrievalConfig.retrievalEnabled) {
        const retrievalInput = {
          ...baseInput,
          knowledgeBaseId: this.knowledgeBaseId,
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: this.retrievalConfig.topK,
            },
          },
          inferenceConfiguration: {
            temperature: this.retrievalConfig.temperature,
            topP: this.retrievalConfig.topP,
          },
        };
        command = new RetrieveAndGenerateCommand(retrievalInput);
      } else {
        command = new InvokeAgentCommand(baseInput);
      }

      try {
        const response = await this.client.send(command);
        const text = new TextDecoder().decode(response.completion);
        
        if (typeof opts?.onProgress === 'function') {
          const baseMessage = {
            id: responseMessageId,
            role: 'assistant',
            parentMessageId: userMessage?.messageId,
            conversationId: conversationId,
          };

          const baseEvent = {
            type: 'message',
            created: Date.now(),
            model: this.modelOptions.model || 'bedrock-agent',
          };

          // Send initial event with empty content
          opts.onProgress({
            ...baseEvent,
            message: { ...baseMessage, content: '' },
            done: false,
          });

          // Send content event
          opts.onProgress({
            ...baseEvent,
            message: { ...baseMessage, content: text },
            done: false,
          });

          // Send completion event
          opts.onProgress({
            ...baseEvent,
            message: { ...baseMessage, content: text },
            done: true,
            final: true,
          });
          
          return { text, messageId: responseMessageId };
        }
        
        // Handle non-streaming response
        return { text, messageId: responseMessageId };
      } catch (error) {
        logger.error('[BedrockAgentClient] Error in sendMessage:', error);
        throw error;
      }
    } catch (error) {
      logger.error('[BedrockAgentClient] Error in sendMessage:', error);
      throw error;
    }
  }

  async getCompletion(payload, onProgress) {
    try {
      const { message } = payload;
      return await this.sendMessage(message, { onProgress });
    } catch (error) {
      logger.error('[BedrockAgentClient] Error in getCompletion:', error);
      throw error;
    }
  }

  async buildMessages(messages, parentMessageId, opts = {}) {
    // Bedrock agents handle their own context management through sessions
    const lastMessage = messages[messages.length - 1];
    return {
      prompt: lastMessage.content,
      messages: messages,
    };
  }

  async getTokenCountForResponse(responseMessage) {
    // Bedrock doesn't expose token counts directly
    // Return a conservative estimate or 0
    return 0;
  }

  getSaveOptions() {
    return {
      agentId: this.agentId,
      agentAliasId: this.agentAliasId,
      region: this.options.region,
      knowledgeBaseId: this.knowledgeBaseId,
      temperature: this.retrievalConfig.temperature,
      topK: this.retrievalConfig.topK,
      topP: this.retrievalConfig.topP,
      modelDisplayLabel: this.options.modelDisplayLabel,
      iconURL: this.options.iconURL,
      greeting: this.options.greeting,
      ...this.modelOptions,
    };
  }

  setOptions(options) {
    if (this.options && !this.options.replaceOptions) {
      this.options.modelOptions = {
        ...this.options.modelOptions,
        ...options.modelOptions,
      };
      delete options.modelOptions;
      this.options = {
        ...this.options,
        ...options,
      };
    } else {
      this.options = options;
    }

    // Update agent configuration if provided
    if (options.agentId) {
      this.agentId = options.agentId;
    }
    if (options.agentAliasId) {
      this.agentAliasId = options.agentAliasId;
    }
    if (options.sessionId) {
      this.sessionId = options.sessionId;
    }
    if (typeof options.enableTrace === 'boolean') {
      this.enableTrace = options.enableTrace;
    }
    if (options.knowledgeBaseId) {
      this.knowledgeBaseId = options.knowledgeBaseId;
      this.retrievalConfig.retrievalEnabled = true;
    }
    if (typeof options.temperature === 'number') {
      this.retrievalConfig.temperature = options.temperature;
    }
    if (typeof options.topK === 'number') {
      this.retrievalConfig.topK = options.topK;
    }
    if (typeof options.topP === 'number') {
      this.retrievalConfig.topP = options.topP;
    }

    return this;
  }
}

module.exports = BedrockAgentClient;
