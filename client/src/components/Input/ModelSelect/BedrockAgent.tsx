import { useState, useEffect } from 'react';
import { SelectDropDown, SelectDropDownPop } from '~/components/ui';
import { useListBedrockAgentsQuery } from 'librechat-data-provider/react-query';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSelectProps } from '~/common';
import { cn, cardStyle } from '~/utils/';

export default function BedrockAgent({
  conversation,
  setOption,
  showAbove = true,
  popover = false,
}: TModelSelectProps) {
  const Menu = popover ? SelectDropDownPop : SelectDropDown;
  const { data, isLoading, error, refetch } = useListBedrockAgentsQuery({
    retry: 2,
    retryDelay: 1000,
    onSuccess: (data) => {
      console.debug('[BedrockAgent] Query success:', {
        agents: data?.agents,
        count: data?.agents?.length ?? 0
      });
    },
    onError: (err) => {
      console.error('[BedrockAgent] Query error:', {
        error: err,
        message: err.message,
        status: err.response?.status
      });
    }
  });
  const agents = data?.agents ?? [];
  const [currentAgentId, setCurrentAgentId] = useState(
    conversation?.agentId ?? 
    process.env.AWS_BEDROCK_AGENT_ID ?? 
    'FZUSVDW4SR'
  );
  
  useEffect(() => {
    // Set initial agent configuration if we have agents
    if (agents.length > 0 && !currentAgentId) {
      const defaultAgent = agents.find(agent => agent.id === process.env.AWS_BEDROCK_AGENT_ID || 'FZUSVDW4SR') || agents[0];
      if (defaultAgent) {
        setCurrentAgentId(defaultAgent.id);
        
        // Set complete configuration for the agent
        const config = {
          agentId: defaultAgent.id,
          agentAliasId: 'TSTALIASID',
          model: 'bedrock-agent',
          endpoint: EModelEndpoint.bedrockAgent,
          endpointType: EModelEndpoint.bedrockAgent,
          region: 'eu-central-1',
          modelDisplayLabel: defaultAgent.name,
          conversation: {
            agentId: defaultAgent.id,
            agentAliasId: 'TSTALIASID',
            model: 'bedrock-agent',
            endpoint: EModelEndpoint.bedrockAgent,
            endpointType: EModelEndpoint.bedrockAgent,
            region: 'eu-central-1'
          }
        };
        
        // Update all configuration fields at once
        Object.entries(config).forEach(([key, val]) => {
          setOption(key, val);
        });
        
        console.debug('[BedrockAgent] Initial configuration set:', config);
      }
    }
  }, [agents, currentAgentId, setOption]);

  useEffect(() => {
    // Refetch agents when component mounts and set initial configuration
    refetch().then(() => {
      if (agents.length > 0) {
        const defaultAgent = agents.find(agent => agent.id === process.env.AWS_BEDROCK_AGENT_ID || 'FZUSVDW4SR') || agents[0];
        if (defaultAgent) {
          setCurrentAgentId(defaultAgent.id);
          setOption('agentId', defaultAgent.id);
          setOption('model', 'bedrock-agent');
          setOption('endpoint', EModelEndpoint.bedrockAgent);
          setOption('endpointType', EModelEndpoint.bedrockAgent);
        }
      }
    });
  }, [refetch, agents, setOption]);

  useEffect(() => {
    if (conversation?.agentId) {
      setCurrentAgentId(conversation.agentId);
      console.debug('[BedrockAgent] Conversation agentId updated:', conversation.agentId);
    }
  }, [conversation?.agentId]);

  useEffect(() => {
    // Set initial agent if none selected and agents are available
    if (!currentAgentId && agents.length > 0) {
      const defaultAgent = agents.find(agent => agent.id === process.env.AWS_BEDROCK_AGENT_ID || 'FZUSVDW4SR') || agents[0];
      if (defaultAgent) {
        console.debug('[BedrockAgent] Setting default agent:', defaultAgent);
        
        // Create a complete configuration object
        const agentConfig = {
          endpoint: EModelEndpoint.bedrockAgent,
          endpointType: EModelEndpoint.bedrockAgent,
          model: 'bedrock-agent',
          agentId: defaultAgent.id,
          agentAliasId: 'TSTALIASID',
          modelDisplayLabel: defaultAgent.name,
          region: process.env.AWS_REGION || 'eu-central-1',
          conversation: {
            endpoint: EModelEndpoint.bedrockAgent,
            endpointType: EModelEndpoint.bedrockAgent,
            agentId: defaultAgent.id,
            agentAliasId: 'TSTALIASID',
            model: 'bedrock-agent',
            modelDisplayLabel: defaultAgent.name,
            region: process.env.AWS_REGION || 'eu-central-1'
          }
        };
        
        // Update all configuration fields at once
        Object.entries(agentConfig).forEach(([key, val]) => {
          setOption(key, val);
        });
        
        setCurrentAgentId(defaultAgent.id);
        
        console.debug('[BedrockAgent] Initial configuration set:', agentConfig);
        
        // Log state updates for debugging
        console.debug('[BedrockAgent] State updates:', {
          endpoint: EModelEndpoint.bedrockAgent,
          model: 'bedrock-agent',
          agentId: defaultAgent.id,
          agentAliasId: 'TSTALIASID',
          modelDisplayLabel: defaultAgent.name,
          agent: defaultAgent
        });
      }
    }
  }, [agents, currentAgentId, setOption]);

  const agentOptions = agents.map((agent) => ({
    value: agent.id,
    label: agent.name || agent.id,
    description: agent.description,
  }));

  const selectedAgent = agents.find((agent) => agent.id === currentAgentId);

  const errorMessage = error 
    ? `Failed to load Bedrock agents: ${error.message}` 
    : agents.length === 0 
      ? 'No Bedrock agents available. Please configure an agent in AWS Bedrock.'
      : undefined;
  
  console.debug('[BedrockAgent] Component state:', {
    agents,
    currentAgentId,
    error,
    isLoading,
    conversation
  });

  return (
    <>
      <Menu
        value={currentAgentId}
        setValue={(value: string) => {
          const agent = agents.find((a) => a.id === value);
          if (agent) {
            setCurrentAgentId(value);
            
            // Create a complete configuration object
            const agentConfig = {
              endpoint: EModelEndpoint.bedrockAgent,
              endpointType: EModelEndpoint.bedrockAgent,
              model: 'bedrock-agent',
              agentId: value,
              agentAliasId: 'TSTALIASID',
              modelDisplayLabel: agent.name,
              region: process.env.AWS_REGION || 'eu-central-1',
              conversation: {
                endpoint: EModelEndpoint.bedrockAgent,
                endpointType: EModelEndpoint.bedrockAgent,
                agentId: value,
                agentAliasId: 'TSTALIASID',
                model: 'bedrock-agent',
                modelDisplayLabel: agent.name,
                region: process.env.AWS_REGION || 'eu-central-1'
              }
            };

            // Update all configuration fields at once
            Object.entries(agentConfig).forEach(([key, val]) => {
              setOption(key, val);
            });

            // Log state updates for debugging
            console.debug('[BedrockAgent] State updates:', {
              endpoint: EModelEndpoint.bedrockAgent,
              model: 'bedrock-agent',
              agentId: value,
              agentAliasId: 'TSTALIASID',
              modelLabel: agent.name,
              agent
            });
            
            console.debug('[BedrockAgent] Agent selected:', {
              agent,
              currentValue: value,
              conversation: {
                endpoint: EModelEndpoint.bedrockAgent,
                agentId: value,
                agentAliasId: 'TSTALIASID',
                model: 'bedrock-agent',
                modelLabel: agent.name
              }
            });
          }
        }}
        availableValues={agentOptions.map(opt => opt.value)}
        optionLabels={Object.fromEntries(agentOptions.map(opt => [opt.value, opt.label]))}
        showAbove={showAbove}
        className={cn(
          cardStyle,
          'z-50 flex h-[40px] w-48 flex-none items-center justify-center px-4',
          isLoading ? 'opacity-50 cursor-not-allowed' : 'hover:cursor-pointer',
          error ? 'border-red-500' : '',
          !currentAgentId && 'border-yellow-500'
        )}
        text={
          isLoading 
            ? 'Loading agents...' 
            : error 
              ? 'Error loading agents' 
              : selectedAgent?.name || 'Select Agent'
        }
        disabled={isLoading}
        title={
          errorMessage || 
          (selectedAgent 
            ? `${selectedAgent.name} - ${selectedAgent.status}\n${selectedAgent.description}` 
            : 'Please select a Bedrock agent to continue')
        }
      />
      {error && (
        <div className="text-red-500 text-sm mt-2">
          Failed to load Bedrock agents. Please check your AWS credentials and try again.
        </div>
      )}
      {!error && !currentAgentId && (
        <div className="text-yellow-500 text-sm mt-2">
          Please select an agent to start the conversation
        </div>
      )}
    </>
  );
}
