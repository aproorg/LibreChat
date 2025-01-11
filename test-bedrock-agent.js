const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');

async function testBedrockAgent() {
  try {
    console.log('Testing AWS credentials and Bedrock Agent access...');
    console.log('AWS Region:', process.env.AWS_REGION);
    console.log('Agent ID:', process.env.AWS_BEDROCK_AGENT_ID);
    
    const client = new BedrockAgentRuntimeClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const input = {
      agentId: process.env.AWS_BEDROCK_AGENT_ID,
      agentAliasId: process.env.AWS_BEDROCK_AGENT_ALIAS_ID || 'AIDACKCEVSQ6M2EXAMPLE',
      sessionId: 'test-session-' + Date.now(),
      inputText: 'Hello! What can you help me with?'
    };

    console.log('\nSending test prompt to agent...');
    const command = new InvokeAgentCommand(input);
    const response = await client.send(command);
    
    console.log('\nSuccessfully connected to Bedrock Agent API');
    console.log('Agent response:', JSON.stringify(response, null, 2));

    if (response.completion) {
      console.log('\nCompletion text:', new TextDecoder().decode(response.completion));
    }
  } catch (error) {
    console.error('Error testing Bedrock Agent:', error);
    console.error('Error details:', error.message);
    if (error.Code) {
      console.error('AWS Error Code:', error.Code);
    }
    if (error.$metadata) {
      console.error('AWS Metadata:', JSON.stringify(error.$metadata, null, 2));
    }
  }
}

testBedrockAgent();
