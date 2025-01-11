const { BedrockAgentClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');

async function testBedrockAgent() {
  try {
    console.log('Testing AWS credentials and Bedrock Agent access...');
    console.log('AWS Region:', process.env.AWS_REGION);
    
    const client = new BedrockAgentClient({
      region: process.env.AWS_REGION || 'eu-central-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    console.log('\nListing available Bedrock Agents...');
    const command = new ListAgentsCommand({});
    const response = await client.send(command);
    
    console.log('\nSuccessfully connected to Bedrock Agent API');
    if (response.agentSummaries && response.agentSummaries.length > 0) {
      console.log('\nAvailable agents:');
      response.agentSummaries.forEach(agent => {
        console.log(`\nAgent Name: ${agent.agentName}`);
        console.log(`Agent ID: ${agent.agentId}`);
        console.log(`Status: ${agent.agentStatus}`);
        console.log(`Created: ${agent.creationDateTime}`);
      });
    } else {
      console.log('No agents found in this account/region');
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
