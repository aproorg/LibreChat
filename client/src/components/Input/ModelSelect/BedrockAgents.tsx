import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { FC } from 'react';
import type { TModelSelectProps, Option } from '~/common/types';
import type { TBedrockAgent } from 'librechat-data-provider';
import useLocalize from '~/hooks/useLocalize';
import cn from '~/utils/cn';
import SelectDropDown from '~/components/ui/SelectDropDown';
import { useQueryClient } from '@tanstack/react-query';

type BedrockAgentsProps = Omit<TModelSelectProps, 'models'> & {
  models: Array<TBedrockAgent | string>;
};

const BedrockAgents: FC<BedrockAgentsProps> = ({
  conversation,
  setOption,
  models,
  showAbove = true,
  popover = false,
}) => {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);
  const [selectedAgent, setSelectedAgent] = useState<Option | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Initialize component state
  useEffect(() => {
    if (!initRef.current && models.length > 0) {
      initRef.current = true;
      console.log('BedrockAgents initializing with models:', models);
      
      // Find current model in conversation or use first available
      const currentModel = conversation?.model 
        ? models.find(model => 
            typeof model === 'string' 
              ? model === conversation.model 
              : model.id === conversation.model
          )
        : models[0];

      if (currentModel) {
        const formattedOption = formatAgentOption(currentModel);
        setSelectedAgent(formattedOption);
        if (!conversation?.model) {
          onSelect(formattedOption);
        }
      }
    }
  }, [models, conversation?.model]);

  // Force a re-fetch of agents when the component mounts
  useEffect(() => {
    queryClient.invalidateQueries(['bedrockAgents']);
  }, [queryClient]);

  const onSelect = useCallback((value: string | Option) => {
    console.log('BedrockAgents onSelect called with:', value);
    if (!value) return;

    const modelValue = typeof value === 'object' ? value.value : value;
    if (!modelValue) return;

    // Only update state if necessary
    const needsEndpointUpdate = !conversation?.endpoint || conversation.endpoint !== 'bedrockAgents';
    const needsConversationId = !conversation?.conversationId;

    // Find and format the selected model
    const selectedModel = models.find(model => 
      typeof model === 'string'
        ? model === modelValue
        : model.id === modelValue
    );
    
    if (selectedModel) {
      const formattedOption = formatAgentOption(selectedModel);
      const agentId = typeof selectedModel === 'string' ? selectedModel : selectedModel.id;
      
      console.log('Setting Bedrock Agent:', {
        agentId,
        formattedOption,
        selectedModel
      });
      
      setSelectedAgent(formattedOption);
      setIsOpen(false);
      
      // Batch state updates
      React.startTransition(() => {
        if (needsEndpointUpdate) {
          setOption('endpoint')('bedrockAgents');
          setOption('endpointType')('bedrockAgents');
        }
        setOption('model')(agentId);
        setOption('agentId')(agentId);
        if (needsConversationId) {
          setOption('conversationId')(`conv-${Date.now()}`);
        }
      });
    }
  }, [setOption, models, conversation?.endpoint, conversation?.conversationId, setSelectedAgent, setIsOpen]);

  const formatAgentOption = (agent: TBedrockAgent | string): Option => {
    if (typeof agent === 'string') {
      return {
        value: agent,
        label: agent,
        display: agent
      };
    }
    return {
      value: agent.id,
      label: agent.name,
      display: agent.name
    };
  };

  const hasValue = selectedAgent !== null;

  // Debug logs for component props and state
  console.log('BedrockAgents Component Props:', {
    conversation,
    models,
    showAbove,
    popover,
    hasValue,
    selectedAgent,
    availableValues: Array.isArray(models) ? models.map(formatAgentOption) : [],
  });

  return (
    <div className="flex w-full flex-col">
      <div className="mb-3">
        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {localize('com_ui_available')} {localize('com_ui_bedrock_agents')}
        </div>
        <div className="mt-1 text-xs text-gray-600 dark:text-gray-400 italic">
          {localize('com_ui_aws_bedrock_agent')}
        </div>
      </div>
      <div 
        ref={dropdownRef}
        className="relative w-full" 
        data-testid="agent-dropdown-container"
        style={{ zIndex: 1050 }}
      >
        <SelectDropDown
          data-testid="bedrock-agent-select"
          id="agent-select"
          title="Select Bedrock Agent"
          value={selectedAgent || { value: '', label: 'Select Agent', display: 'Select Agent' }}
          setValue={onSelect}
          availableValues={Array.isArray(models) ? models.map(formatAgentOption) : []}
          showAbove={showAbove}
          showLabel={false}
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          className="rounded-md border-2 border-black/10 bg-white py-2 pl-3 pr-10 text-left hover:border-green-500 dark:border-gray-600 dark:bg-gray-700"
          optionsClass="hover:bg-gray-100 dark:hover:bg-gray-600"
          currentValueClass={cn(
            'text-md font-semibold text-gray-900 dark:text-white',
            !hasValue ? 'text-gray-500' : '',
          )}
          searchPlaceholder={localize('com_agents_search_name')}
          placeholder={`${localize('com_ui_select')} ${localize('com_ui_agent')}`}
          showOptionIcon={true}
          containerClassName="w-full"
        />
      </div>
    </div>
  );
}

export default BedrockAgents;
