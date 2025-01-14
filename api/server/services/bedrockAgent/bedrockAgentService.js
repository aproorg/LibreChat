const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { klona } = require('klona');
const {
  EModelEndpoint,
  ContentTypes,
  RunStatus,
  StepStatus,
  StepTypes,
  ToolCallTypes,
  defaultOrderQuery,
} = require('librechat-data-provider');
const { processRequiredActions } = require('~/server/services/ToolService');
const { createOnProgress, sendMessage, sleep } = require('~/server/utils');
const { RunManager, waitForRun } = require('~/server/services/Runs');
const { TextStream } = require('~/app/clients');
const { logger } = require('~/config');

/**
 * Creates a handler function for processing streaming responses from Bedrock Agent.
 *
 * @param {Object} params - Parameters for creating the text progress handler.
 * @param {Object} params.client - The Bedrock Agent client instance.
 * @param {string} params.conversationId - The current conversation ID.
 * @param {string} params.userMessageId - The user message ID (parent message).
 * @param {string} params.messageId - The response message ID.
 * @returns {void}
 */
async function createOnTextProgress({
  client,
  conversationId,
  userMessageId,
  messageId,
}) {
  client.responseMessage = {
    conversationId,
    parentMessageId: userMessageId,
    role: 'assistant',
    messageId,
    content: [],
  };

  client.responseText = '';
  client.index = 0;
  client.mappedOrder = new Map();
  client.seenToolCalls = new Map();
  client.processedFileIds = new Set();
  client.completeToolCallSteps = new Set();

  client.addContentData = (data) => {
    const { type, index } = data;
    client.responseMessage.content[index] = { type, [type]: data[type] };

    if (type === ContentTypes.TEXT) {
      client.responseText += data[type].value;
      return;
    }

    const contentData = {
      index,
      type,
      [type]: data[type],
      messageId,
      conversationId,
    };

    logger.debug('Content data:', contentData);
    sendMessage(client.res, contentData);
  };
}

/**
 * Initializes a Bedrock Agent client with the provided configuration.
 *
 * @param {Object} options - Configuration options for the client.
 * @param {Object} options.req - The request object.
 * @param {Object} options.res - The response object.
 * @param {Object} options.endpointOption - Endpoint-specific configuration.
 * @returns {Promise<Object>} The initialized client instance.
 */
async function initializeBedrockAgentClient({ req, res, endpointOption }) {
  const {
    AWS_REGION,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
  } = process.env;

  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials not configured');
  }

  const client = new BedrockAgentRuntimeClient({
    region: AWS_REGION || endpointOption.region || 'us-east-1',
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  client.req = req;
  client.res = res;

  return { client };
}

/**
 * Processes a streaming response from the Bedrock Agent.
 *
 * @param {Object} stream - The message stream from Bedrock Agent.
 * @param {Function} onProgress - Progress callback for streaming updates.
 * @returns {Promise<string>} The complete response text.
 */
async function processStreamingResponse(stream, onProgress) {
  let text = '';
  const decoder = new TextDecoder();
  
  try {
    for await (const chunk of stream) {
      if (chunk.headers?.[':exception-type']?.value) {
        const errorMessage = decoder.decode(chunk.body);
        logger.error('AWS Bedrock Agent Error:', {
          type: chunk.headers[':exception-type'].value,
          message: errorMessage,
        });
        throw new Error(`AWS Error: ${chunk.headers[':exception-type'].value} - ${errorMessage}`);
      }

      let chunkText = '';
      if (chunk.chunk?.bytes) {
        chunkText = decoder.decode(chunk.chunk.bytes);
      } else if (chunk.message) {
        chunkText = chunk.message;
      } else if (chunk.body instanceof Uint8Array) {
        chunkText = decoder.decode(chunk.body);
      } else if (Buffer.isBuffer(chunk.body)) {
        chunkText = chunk.body.toString('utf-8');
      } else if (typeof chunk === 'string') {
        chunkText = chunk;
      } else {
        logger.debug('Unknown chunk format:', {
          type: typeof chunk,
          hasBody: !!chunk.body,
          bodyType: chunk.body ? typeof chunk.body : 'none',
          properties: Object.keys(chunk),
        });
      }

      if (chunkText) {
        text += chunkText;
        if (onProgress) {
          await sleep(9); // Match TextStream delay
          await onProgress(chunkText);
        }
      }
    }
  } catch (error) {
    logger.error('Error processing stream:', {
      name: error.name,
      message: error.message,
      code: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId,
    });
    throw error;
  }

  return text;
}

/**
 * Runs the Bedrock Agent with the provided parameters.
 *
 * @param {Object} params - Parameters for running the agent.
 * @param {Object} params.client - The initialized Bedrock Agent client.
 * @param {string} params.agentId - The ID of the agent to invoke.
 * @param {string} params.agentAliasId - The alias ID of the agent version.
 * @param {string} params.sessionId - The session ID for the conversation.
 * @param {string} params.inputText - The user's input text.
 * @param {string} params.messageId - The current message ID.
 * @param {string} params.conversationId - The current conversation ID.
 * @param {string} params.parentMessageId - The parent message ID.
 * @returns {Promise<Object>} The agent's response and metadata.
 */
async function runBedrockAgent({
  client,
  agentId,
  agentAliasId,
  sessionId,
  inputText,
  messageId,
  conversationId,
  parentMessageId,
}) {
  await createOnTextProgress({
    client,
    conversationId,
    userMessageId: parentMessageId,
    messageId,
  });

  const command = new InvokeAgentCommand({
    agentId,
    agentAliasId,
    sessionId,
    inputText,
    enableTrace: true,
  });

  try {
    const response = await client.send(command);
    
    if (!response.completion && !response.actionGroup) {
      throw new Error('No completion or action group in agent response');
    }

    // Initialize run with response data
    const run = {
      id: response.requestId || `run-${Date.now()}`,
      status: response.completion ? RunStatus.COMPLETED : RunStatus.REQUIRES_ACTION,
      thread_id: sessionId,
      agentId,
      agentAliasId,
      sessionId,
    };

    // Check for tool calls in the response
    if (response.actionGroup?.actions?.length > 0) {
      run.status = RunStatus.REQUIRES_ACTION;
      run.required_action = {
        submit_tool_outputs: {
          tool_calls: response.actionGroup.actions.map((action) => ({
            id: action.actionId,
            type: ToolCallTypes.FUNCTION,
            function: {
              name: action.apiName,
              arguments: JSON.stringify(action.parameters || {}),
            },
          })),
        },
      };
    }

    // Use manageBedrockRun for handling the run lifecycle
    const result = await manageBedrockRun({
      client,
      run_id: run.id,
      thread_id: sessionId,
    });

    return {
      ...result,
      metadata: response.$metadata,
      requestId: response.$metadata?.requestId,
    };
  } catch (error) {
    logger.error('Error in Bedrock Agent run:', {
      name: error.name,
      message: error.message,
      code: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId,
    });
    throw error;
  }
}

/**
 * Filters the steps to keep only the most recent instance of each unique step.
 * @param {RunStep[]} steps - The array of RunSteps to filter.
 * @return {RunStep[]} The filtered array of RunSteps.
 */
function filterSteps(steps = []) {
  if (steps.length <= 1) {
    return steps;
  }
  const stepMap = new Map();

  steps.forEach((step) => {
    if (!step) {
      return;
    }

    const effectiveTimestamp = Math.max(
      step.created_at,
      step.expired_at || 0,
      step.cancelled_at || 0,
      step.failed_at || 0,
      step.completed_at || 0,
    );

    if (!stepMap.has(step.id) || effectiveTimestamp > stepMap.get(step.id).effectiveTimestamp) {
      const latestStep = { ...step, effectiveTimestamp };
      stepMap.set(step.id, latestStep);
    }
  });

  return Array.from(stepMap.values()).map((step) => {
    delete step.effectiveTimestamp;
    return step;
  });
}

/**
 * Manages the Bedrock Agent run with step tracking and tool call handling.
 *
 * @param {Object} params - Parameters for managing the run.
 * @param {Object} params.client - The Bedrock Agent client instance.
 * @param {string} params.run_id - The ID of the run to manage.
 * @param {string} params.thread_id - The thread ID for the conversation.
 * @param {RunStep[]} params.accumulatedSteps - Previously accumulated steps.
 * @param {Object[]} params.accumulatedMessages - Previously accumulated messages.
 * @returns {Promise<Object>} The run results including messages and steps.
 */
async function manageBedrockRun({
  client,
  run_id,
  thread_id,
  accumulatedSteps = [],
  accumulatedMessages = [],
}) {
  let steps = accumulatedSteps;
  let messages = accumulatedMessages;

  const runManager = new RunManager({
    final: async ({ step, runStatus, stepsByStatus }) => {
      logger.debug(`[manageBedrockRun] Final step for ${run_id} with status ${runStatus}`, step);

      const promises = [];
      for (const [_status, stepsPromises] of Object.entries(stepsByStatus)) {
        promises.push(...stepsPromises);
      }

      const resolved = await Promise.all(promises);
      const finalSteps = filterSteps(steps.concat(resolved));

      resolved.push(step);
      steps = klona(finalSteps);
    },
  });

  const { pollIntervalMs = 2000, timeoutMs = 60000 } = client.req.app.locals?.[EModelEndpoint.bedrockAgent] ?? {};

  const run = await waitForRun({
    client,
    run_id,
    thread_id,
    runManager,
    pollIntervalMs,
    timeout: timeoutMs,
  });

  if (!run.required_action) {
    return {
      run,
      steps,
      messages,
      finalMessage: client.responseMessage,
      text: client.responseText,
    };
  }

  const { submit_tool_outputs } = run.required_action;
  const actions = submit_tool_outputs.tool_calls.map((item) => {
    const functionCall = item.function;
    const args = JSON.parse(functionCall.arguments);
    return {
      tool: functionCall.name,
      toolInput: args,
      toolCallId: item.id,
      run_id,
      thread_id,
    };
  });

  const outputs = await processRequiredActions(client, actions);
  const toolRun = await client.send(new InvokeAgentCommand({
    agentId: run.agentId,
    agentAliasId: run.agentAliasId,
    sessionId: run.sessionId,
    toolOutputs: outputs,
  }));

  return manageBedrockRun({
    client,
    run_id: toolRun.id,
    thread_id,
    accumulatedSteps: steps,
    accumulatedMessages: messages,
  });
}

module.exports = {
  initializeBedrockAgentClient,
  runBedrockAgent,
  createOnTextProgress,
  manageBedrockRun,
};
