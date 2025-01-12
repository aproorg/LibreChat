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
  const { data, isLoading, error } = useListBedrockAgentsQuery();
  const agents = data?.agents ?? [];
  const [currentAgentId, setCurrentAgentId] = useState(conversation?.agentId ?? '');

  useEffect(() => {
    if (conversation?.agentId) {
      setCurrentAgentId(conversation.agentId);
      console.debug('[BedrockAgent] Conversation agentId updated:', conversation.agentId);
    }
  }, [conversation?.agentId]);

  const agentOptions = agents.map((agent) => ({
    value: agent.id,
    label: agent.name || agent.id,
    description: agent.description,
  }));

  const selectedAgent = agents.find((agent) => agent.id === currentAgentId);

  const errorMessage = error 
    ? 'Failed to load Bedrock agents. Please try again later.' 
    : agents.length === 0 
      ? 'No Bedrock agents available. Please configure an agent in AWS Bedrock.'
      : undefined;

  return (
    <>
      <Menu
        value={currentAgentId}
        setValue={(value: string) => {
          const agent = agents.find((a) => a.id === value);
          if (agent) {
            setCurrentAgentId(value);
            
            // Update individual fields first
            setOption('endpoint', EModelEndpoint.bedrockAgent);
            setOption('model', 'bedrock-agent');
            setOption('agentId', value);
            setOption('modelLabel', agent.name);

            // Log state updates for debugging
            console.debug('[BedrockAgent] State updates:', {
              endpoint: EModelEndpoint.bedrockAgent,
              model: 'bedrock-agent',
              agentId: value,
              modelLabel: agent.name,
              agent
            });
            
            console.debug('[BedrockAgent] Agent selected:', {
              agent,
              currentValue: value,
              conversation: {
                endpoint: EModelEndpoint.bedrockAgent,
                agentId: value,
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
