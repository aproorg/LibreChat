const {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} = require('@aws-sdk/client-bedrock-agent-runtime');
const { logger } = require('~/config');

/**
 * @typedef {Object} BedrockAgentCredentials
 * @property {string} accessKeyId - AWS access key ID
 * @property {string} secretAccessKey - AWS secret access key
 * @property {string} region - AWS region
 */

/**
 * @typedef {Object} BedrockAgentConfig
 * @property {string} agentId - Bedrock agent ID
 * @property {string} agentAliasId - Bedrock agent alias ID
 * @property {string} sessionId - Session ID for the conversation
 * @property {string} prompt - Input text for the agent
 */

/**
 * Initialize a Bedrock Agent Runtime client with AWS credentials
 * @returns {BedrockAgentRuntimeClient} Initialized Bedrock Agent client
 * @throws {Error} If required AWS credentials are missing
 */
const initializeAgentClient = () => {
  try {
    if (!process.env.AWS_REGION) {
      throw new Error('AWS_REGION is required');
    }
    if (!process.env.AWS_ACCESS_KEY_ID) {
      throw new Error('AWS_ACCESS_KEY_ID is required');
    }
    if (!process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error('AWS_SECRET_ACCESS_KEY is required');
    }

    return new BedrockAgentRuntimeClient({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  } catch (error) {
    logger.error('Failed to initialize Bedrock Agent client:', error);
    throw error;
  }
};

/**
 * Create an InvokeAgentCommand for the Bedrock Agent
 * @param {BedrockAgentConfig} config - Configuration for the agent command
 * @returns {InvokeAgentCommand} Command to invoke the Bedrock Agent
 * @throws {Error} If required agent configuration is missing
 */
const createAgentCommand = ({ agentId, agentAliasId, sessionId, prompt }) => {
  try {
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    if (!prompt) {
      throw new Error('prompt is required');
    }

    return new InvokeAgentCommand({
      agentId: agentId || process.env.AWS_BEDROCK_AGENT_ID,
      agentAliasId: agentAliasId || process.env.AWS_BEDROCK_AGENT_ALIAS_ID,
      sessionId,
      inputText: prompt,
    });
  } catch (error) {
    logger.error('Failed to create Bedrock Agent command:', error);
    throw error;
  }
};

/**
 * Invoke a Bedrock Agent and handle streaming responses
 * @param {Object} params - Parameters for invoking the agent
 * @param {BedrockAgentRuntimeClient} params.client - Initialized Bedrock Agent client
 * @param {InvokeAgentCommand} params.command - Command to invoke the agent
 * @param {Function} [params.onProgress] - Callback for handling streaming responses
 * @returns {Promise<Object>} Object containing the complete response
 * @throws {Error} If the agent invocation fails or response is invalid
 */
const invokeAgent = async ({ client, command, onProgress }) => {
  try {
    let completion = '';
    const response = await client.send(command);

    if (!response?.completion) {
      throw new Error('Invalid response: completion is undefined');
    }

    for await (const chunkEvent of response.completion) {
      if (!chunkEvent?.chunk?.bytes) {
        logger.warn('Invalid chunk received from Bedrock Agent');
        continue;
      }

      const decodedResponse = new TextDecoder('utf-8').decode(chunkEvent.chunk.bytes);
      completion += decodedResponse;

      if (onProgress) {
        try {
          onProgress(decodedResponse);
        } catch (error) {
          logger.error('Error in progress callback:', error);
        }
      }
    }

    return { completion };
  } catch (error) {
    logger.error('Error invoking Bedrock Agent:', {
      error,
      command: command.input,
    });
    throw error;
  }
};

module.exports = {
  initializeAgentClient,
  createAgentCommand,
  invokeAgent,
};
