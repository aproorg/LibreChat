import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { EModelEndpoint } from 'librechat-data-provider';
import { isEnabled } from '~/server/utils';
import BaseClient from './BaseClient';
import { logger } from '~/config';

class BedrockAgentClient extends BaseClient {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.sender = options.sender ?? 'Bedrock';
    this.contextStrategy = options.contextStrategy ? options.contextStrategy.toLowerCase() : 'discard';
    this.shouldSummarize = this.contextStrategy === 'summarize';
    
    // Initialize AWS Bedrock client
    this.client = new BedrockAgentRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
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

      if (typeof opts?.onProgress === 'function') {
        // Handle streaming response
        const response = await this.client.send(command);
        const chunks = [];

        for await (const chunk of response.completion) {
          const text = new TextDecoder().decode(chunk.bytes);
          chunks.push(text);
          opts.onProgress(text);
        }

        const fullResponse = chunks.join('');
        return { response: fullResponse };
      } else {
        // Handle non-streaming response
        const response = await this.client.send(command);
        const text = new TextDecoder().decode(response.completion);
        return { response: text };
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

export default BedrockAgentClient;
