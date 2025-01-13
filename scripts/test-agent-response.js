const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');

async function testAgentResponse({ agentId, agentAliasId }) {
  try {
    console.log('\nTesting AWS Bedrock Agent Response:');
    console.log('================================');
    console.log('Configuration:', {
      agentId,
      agentAliasId,
      region: process.env.AWS_REGION,
      hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
      hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY
    });

    const client = new BedrockAgentRuntimeClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const input = {
      agentId,
      agentAliasId,
      sessionId: 'test-session-' + Date.now(),
      inputText: 'Hello! Can you tell me what capabilities you have as an agent?',
      enableTrace: true
    };

    console.log('Request Parameters:', {
      agentId: input.agentId,
      sessionId: input.sessionId,
      inputText: input.inputText
    });

    const command = new InvokeAgentCommand(input);
    console.log('\nSending request to AWS Bedrock...');
    const response = await client.send(command);

    if (!response.completion) {
      throw new Error('No completion in agent response');
    }

    let text = '';
    console.log('Processing response...');
    console.log('Response type:', typeof response.completion);
    console.log('Has messageStream:', !!response.completion?.options?.messageStream);
    
    if (response.completion?.options?.messageStream) {
      console.log('Processing streaming response...');
      const stream = response.completion.options.messageStream;
      for await (const chunk of stream) {
        console.log('Received chunk:', chunk);
        
        if (chunk.headers?.[':exception-type']?.value) {
          const errorMessage = new TextDecoder().decode(chunk.body);
          console.error('AWS Error:', {
            type: chunk.headers[':exception-type'].value,
            message: errorMessage
          });
          throw new Error(`AWS Error: ${chunk.headers[':exception-type'].value} - ${errorMessage}`);
        }
        
        let chunkText = '';
        if (chunk.chunk?.bytes) {
          chunkText = new TextDecoder().decode(chunk.chunk.bytes);
        } else if (chunk.message) {
          chunkText = chunk.message;
        } else if (chunk.body instanceof Uint8Array) {
          chunkText = new TextDecoder().decode(chunk.body);
        } else {
          console.debug('Unknown chunk format:', {
            type: typeof chunk,
            hasBody: !!chunk.body,
            bodyType: chunk.body ? typeof chunk.body : 'none',
            properties: Object.keys(chunk)
          });
          continue;
        }
        
        text += chunkText;
        // Print chunks as they arrive
        process.stdout.write(chunkText);
      }
    } else if (response.completion instanceof Uint8Array) {
      console.log('Processing Uint8Array response...');
      text = new TextDecoder().decode(response.completion);
    } else if (Buffer.isBuffer(response.completion)) {
      console.log('Processing Buffer response...');
      text = response.completion.toString('utf-8');
    } else if (typeof response.completion === 'string') {
      console.log('Processing string response...');
      text = response.completion;
    } else {
      console.error('Unexpected completion type:', {
        type: typeof response.completion,
        value: JSON.stringify(response.completion, null, 2),
        properties: Object.keys(response.completion || {})
      });
      throw new Error('Unexpected completion type from Bedrock agent');
    }

    console.log('\nAgent Response:');
    console.log('--------------------------------');
    console.log(text);
    console.log('--------------------------------');

    return {
      text,
      metadata: response.$metadata,
      requestId: response.$metadata?.requestId
    };
  } catch (error) {
    console.error('\nError testing agent:', {
      name: error.name,
      message: error.message,
      code: error.$metadata?.httpStatusCode,
      requestId: error.$metadata?.requestId
    });
    throw error;
  }
}

// Test both available agents
async function main() {
  // Try agents with and without alias
  const agents = [
    // Only try with TSTALIASID as configured in librechat.yaml
    { id: 'FZUSVDW4SR', alias: 'TSTALIASID' },
    { id: 'SLBEYXPT6I', alias: 'TSTALIASID' }
  ];

  for (const agent of agents) {
    console.log(`\n=== Testing Agent ${agent.id} ===`);
    try {
      const params = {
        agentId: agent.id,
        ...(agent.alias && { agentAliasId: agent.alias })
      };
      console.log('Testing with params:', params);
      const result = await testAgentResponse(params);
      console.log('\nTest completed successfully!');
      console.log('Request ID:', result.requestId);
      console.log('HTTP Status:', result.metadata?.httpStatusCode);
    } catch (error) {
      console.error(`\nTest failed for agent ${agent.id}:`, error.message);
      // Continue testing next agent
      continue;
    }
  }
}

// Track test success
let integration_test_passed = false;

// Run the tests
main()
  .then(() => {
    integration_test_passed = true;
    console.log('\nIntegration Test Status:', {
      passed: integration_test_passed,
      timestamp: new Date().toISOString(),
      environment: {
        region: process.env.AWS_REGION,
        hasAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
        hasSecretKey: !!process.env.AWS_SECRET_ACCESS_KEY
      }
    });
  })
  .catch((error) => {
    integration_test_passed = false;
    console.error('\nIntegration Test Failed:', error);
    process.exit(1);
  });
