const {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  RetrieveAndGenerateCommand,
  GetAgentMemoryCommand,
  DeleteAgentMemoryCommand,
} = require('@aws-sdk/client-bedrock-agent-runtime');
const { EModelEndpoint } = require('librechat-data-provider');
const { isEnabled } = require('../../server/utils');
const BaseClient = require('./BaseClient');
const { logger } = require('../../config');

// AWS SDK v3 client configuration
const defaultClientConfig = {
  maxAttempts: 3,
  retryMode: 'standard',
};

// AWS Bedrock session ID validation pattern
const SESSION_ID_PATTERN = /^[0-9a-zA-Z._:-]{2,100}$/;

function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Session ID must be a non-empty string');
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Session ID must match pattern: ^[0-9a-zA-Z._:-]{2,100}$');
  }
  return true;
}

class BedrockAgentClient extends BaseClient {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.sender = options.sender ?? 'Bedrock';
    this.contextStrategy = options.contextStrategy ? options.contextStrategy.toLowerCase() : 'discard';
    this.shouldSummarize = this.contextStrategy === 'summarize';
    
    // Initialize AWS Bedrock Agent client
    const region = options.region || process.env.AWS_REGION || 'eu-central-1';
    const accessKeyId = options.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;

    this.modelOptions = {
      model: 'bedrock-agent',
      ...options.modelOptions,
    };

    // Initialize the client first with AWS SDK v3 configuration
    this.client = new BedrockAgentRuntimeClient({
      ...defaultClientConfig,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    if (!this.client?.config) {
      throw new Error('Failed to initialize AWS client configuration');
    }

    const safeOptions = {
      region: this.client.config.region,
      agentId: options.agentId,
      agentAliasId: options.agentAliasId,
      modelDisplayLabel: options.modelDisplayLabel,
      endpoint: options.endpoint,
      model: this.modelOptions.model
    };

    logger.debug('[BedrockAgentClient] Initialized with config:', {
      ...safeOptions,
      hasAccessKey: !!this.client.config.credentials?.accessKeyId,
      hasSecretKey: !!this.client.config.credentials?.secretAccessKey
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
      if (!this.client?.config?.region) {
        throw new Error('Client configuration not properly initialized');
      }

      logger.debug('[BedrockAgentClient] Starting sendMessage with:', { 
        message, 
        opts,
        config: {
          region: this.client.config.region,
          agentId: this.agentId,
          agentAliasId: this.agentAliasId,
          hasAccessKey: !!this.client.config.credentials?.accessKeyId,
          hasSecretKey: !!this.client.config.credentials?.secretAccessKey
        }
      });

      // Ensure session continuity with validation
      if (!this.sessionId) {
        if (!conversationId) {
          throw new Error('Conversation ID is required for session continuity');
        }
        validateSessionId(conversationId);
        this.sessionId = conversationId;
        logger.debug('[BedrockAgentClient] Session ID set:', {
          sessionId: this.sessionId,
          pattern: SESSION_ID_PATTERN.source
        });
      }

      // Build base input with required parameters
      const baseInput = {
        agentId: this.agentId,
        sessionId: this.sessionId,
        enableTrace: this.enableTrace,
        inputText: message,
      };

      // Only include agentAliasId if it has a value
      if (this.agentAliasId) {
        baseInput.agentAliasId = this.agentAliasId;
      }

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
        // Use InvokeAgent without alias ID first
        const commandInput = {
          agentId: this.agentId,
          sessionId: this.sessionId,
          inputText: message,
          enableTrace: this.enableTrace
        };

        // Only include agentAliasId if explicitly provided
        if (this.agentAliasId && this.agentAliasId !== 'undefined') {
          commandInput.agentAliasId = this.agentAliasId;
        }

        logger.debug('[BedrockAgentClient] Preparing InvokeAgentCommand:', {
          ...commandInput,
          credentials: {
            hasAccessKey: !!this.client.config.credentials?.accessKeyId,
            hasSecretKey: !!this.client.config.credentials?.secretAccessKey,
            region: this.client.config.region
          }
        });

        command = new InvokeAgentCommand(commandInput);
      }

      try {
        logger.debug('[BedrockAgentClient] Sending command:', JSON.stringify(command, null, 2));
        logger.debug('[BedrockAgentClient] Using AWS credentials:', {
          region: this.client.config.region,
          hasAccessKey: !!this.client.config.credentials.accessKeyId,
          hasSecretKey: !!this.client.config.credentials.secretAccessKey,
          agentId: this.agentId,
          agentAliasId: this.agentAliasId,
          sessionId: this.sessionId
        });
        
        // Log detailed request information
        logger.debug('[BedrockAgentClient] Sending AWS Bedrock request:', {
          command: command.input,
          region: this.client.config.region,
          credentials: {
            hasAccessKey: !!this.client.config.credentials?.accessKeyId,
            hasSecretKey: !!this.client.config.credentials?.secretAccessKey,
            accessKeyId: this.client.config.credentials?.accessKeyId?.substring(0, 5) + '...',
            region: this.client.config.region
          },
          sessionId: this.sessionId,
          agentId: this.agentId,
          requestDetails: {
            method: 'POST',
            url: `https://bedrock-agent-runtime.${this.client.config.region}.amazonaws.com/`,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'LibreChat/1.0.0'
            }
          }
        });

        // Verify AWS configuration
        if (!this.client.config.region) {
          throw new Error('AWS region not configured');
        }
        
        // Log environment variables (safely)
        logger.debug('[BedrockAgentClient] Environment check:', {
          AWS_REGION: process.env.AWS_REGION,
          hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
          hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY
        });

        // Verify AWS credentials are properly set
        if (!this.client.config.credentials?.accessKeyId || !this.client.config.credentials?.secretAccessKey) {
          logger.error('[BedrockAgentClient] AWS credentials not properly configured');
          throw new Error('AWS credentials not properly configured');
        }

        // Return mock response for testing if using mock agent
        let response;
        if (this.agentId === 'mock-agent-001') {
          response = {
            completion: {
              options: {
                messageStream: {
                  async *[Symbol.asyncIterator]() {
                    const mockResponse = 'Hello! I am a mock Bedrock Agent. I can help you test the UI integration. This is a simulated response to demonstrate the streaming functionality.';
                    const chunks = mockResponse.match(/[^.!?]+[.!?]+/g) || [mockResponse];
                    for (const chunk of chunks) {
                      yield { chunk: { bytes: new TextEncoder().encode(chunk) } };
                      await new Promise(resolve => setTimeout(resolve, 100)); // Simulate network delay
                    }
                  }
                }
              }
            },
            $metadata: {
              httpStatusCode: 200,
              requestId: `mock-${Date.now()}`,
            }
          };
          logger.debug('[BedrockAgentClient] Using mock response for UI testing');
        } else {
          response = await this.client.send(command);
        }
        logger.debug('[BedrockAgentClient] Raw response:', {
          metadata: response.$metadata,
          completion: response.completion ? '[BINARY_DATA]' : undefined,
          httpStatusCode: response.$metadata?.httpStatusCode,
          requestId: response.$metadata?.requestId,
          hasAgentResponse: !!response.completion
        });
        
        if (!response.completion) {
          throw new Error('No completion in agent response');
        }

        let text;
        if (response.completion instanceof Uint8Array) {
          text = new TextDecoder().decode(response.completion);
        } else if (Buffer.isBuffer(response.completion)) {
          text = response.completion.toString('utf-8');
        } else if (typeof response.completion === 'string') {
          text = response.completion;
        } else if (response.completion?.options?.messageStream) {
          // Handle MessageDecoderStream response
          const stream = response.completion.options.messageStream;
          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const concatenated = Buffer.concat(chunks);
          text = new TextDecoder().decode(concatenated);
        } else {
          logger.error('[BedrockAgentClient] Unexpected completion type:', {
            type: typeof response.completion,
            value: response.completion,
            hasMessageStream: !!response.completion?.options?.messageStream
          });
          throw new Error('Unexpected completion type from Bedrock agent');
        }
        
        logger.debug('[BedrockAgentClient] Decoded response:', {
          text,
          completionType: typeof response.completion,
          isBuffer: Buffer.isBuffer(response.completion),
          isUint8Array: response.completion instanceof Uint8Array
        });

        // Create the response message object with proper JSON structure
        const responseMessage = {
          id: responseMessageId,
          role: 'assistant',
          content: text,
          parentMessageId: userMessage?.messageId,
          conversationId: this.sessionId,
          endpoint: EModelEndpoint.bedrockAgent,
          model: this.modelOptions.model || 'bedrock-agent',
          metadata: {
            agentId: this.agentId,
            agentAliasId: this.agentAliasId,
            sessionId: this.sessionId,
            ...(response.metadata || {}),
          }
        };

        // Ensure valid JSON structure for streaming
        const progressMessage = {
          ...responseMessage,
          content: text || '',
          metadata: {
            ...responseMessage.metadata,
            partial: true
          }
        };

        if (typeof opts?.onProgress === 'function') {
          // Simulate streaming by chunking the response
          const chunks = text.match(/[^.!?]+[.!?]+/g) || [text];
          let accumulatedText = '';

          for (let i = 0; i < chunks.length; i++) {
            accumulatedText += chunks[i];
            const isLast = i === chunks.length - 1;

            // Update progress message with accumulated text
            progressMessage.content = accumulatedText;
            progressMessage.metadata.partial = !isLast;

            const progressEvent = {
              type: 'message',
              message: JSON.parse(JSON.stringify(progressMessage)), // Ensure valid JSON
              created: Date.now(),
              done: isLast,
              final: isLast
            };

            logger.debug('[BedrockAgentClient] Sending progress event:', {
              isLast,
              contentLength: accumulatedText.length
            });
            
            opts.onProgress(progressEvent);

            // Add a small delay between chunks to simulate natural typing
            if (!isLast) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
        }
        
        return { 
          text, 
          messageId: responseMessageId,
          conversationId: this.sessionId,
          metadata: responseMessage.metadata
        };
      } catch (error) {
        logger.error('[BedrockAgentClient] Error in sendMessage:', error);
        
        // Enhance error handling with specific AWS error types
        const errorResponse = {
          error: true,
          message: error.message,
          type: error.name,
          code: error.$metadata?.httpStatusCode,
          details: {
            agentId: this.agentId,
            sessionId: this.sessionId,
            ...(error.$metadata || {})
          }
        };

        // Notify progress handler of error if available
        if (typeof opts?.onProgress === 'function') {
          opts.onProgress({
            type: 'error',
            error: errorResponse,
            created: Date.now(),
            done: true,
            final: true
          });
        }

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

  /**
   * Retrieves agent memory for a specific memory ID
   * @param {string} memoryId - The ID of the memory to retrieve
   * @returns {Promise<Object>} The memory data
   */
  async getAgentMemory(memoryId) {
    if (!memoryId) {
      throw new Error('Memory ID is required');
    }

    try {
      const command = new GetAgentMemoryCommand({
        agentId: this.agentId,
        memoryId,
        sessionId: this.sessionId
      });

      logger.debug('[BedrockAgentClient] Getting agent memory:', {
        agentId: this.agentId,
        memoryId,
        sessionId: this.sessionId
      });

      const response = await this.client.send(command);
      
      if (!response.content) {
        throw new Error('No content in memory response');
      }

      return {
        memoryId,
        content: new TextDecoder().decode(response.content),
        metadata: response.metadata
      };
    } catch (error) {
      logger.error('[BedrockAgentClient] Error getting agent memory:', {
        error: error.message,
        code: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId
      });
      throw error;
    }
  }

  /**
   * Deletes a specific memory entry from the agent
   * @param {string} memoryId - The ID of the memory to delete
   * @returns {Promise<void>}
   */
  async deleteAgentMemory(memoryId) {
    if (!memoryId) {
      throw new Error('Memory ID is required');
    }

    try {
      const command = new DeleteAgentMemoryCommand({
        agentId: this.agentId,
        memoryId,
        sessionId: this.sessionId
      });

      logger.debug('[BedrockAgentClient] Deleting agent memory:', {
        agentId: this.agentId,
        memoryId,
        sessionId: this.sessionId
      });

      await this.client.send(command);
      logger.debug('[BedrockAgentClient] Memory deleted successfully:', { memoryId });
    } catch (error) {
      logger.error('[BedrockAgentClient] Error deleting agent memory:', {
        error: error.message,
        code: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId
      });
      throw error;
    }
  }

  /**
   * Cleans up old memories for the current session
   * @param {number} [maxAge=24*60*60*1000] Maximum age of memories to keep in milliseconds (default: 24 hours)
   * @returns {Promise<void>}
   */
  async cleanupOldMemories(maxAge = 24 * 60 * 60 * 1000) {
    try {
      // This is a placeholder for future implementation
      // We'll need to implement this once AWS provides a ListAgentMemories operation
      logger.debug('[BedrockAgentClient] Cleanup of old memories not yet implemented');
    } catch (error) {
      logger.error('[BedrockAgentClient] Error cleaning up old memories:', {
        error: error.message,
        code: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId
      });
      throw error;
    }
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
      validateSessionId(options.sessionId);
      this.sessionId = options.sessionId;
      logger.debug('[BedrockAgentClient] Session ID updated in setOptions:', {
        sessionId: this.sessionId,
        pattern: SESSION_ID_PATTERN.source
      });
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
