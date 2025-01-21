import React from 'react';
import type { TModelSelectProps, Option } from '~/common/types';
import type { TBedrockAgent } from 'librechat-data-provider';
import useLocalize from '~/hooks/useLocalize';
import cn from '~/utils/cn';
import SelectDropDown from '~/components/ui/SelectDropDown';
import { Plus } from 'lucide-react';

export default function BedrockAgents({
  conversation,
  setOption,
  models,
  showAbove = true,
  popover = false,
}: TModelSelectProps & { models: Array<TBedrockAgent> }) {
  const localize = useLocalize();

  const onSelect = (value: string | Option) => {
    console.log('BedrockAgents onSelect called with:', value);
    if (!value) {
      console.log('BedrockAgents: No value provided');
      return;
    }
    const modelValue = typeof value === 'object' ? value.value : value;
    if (modelValue) {
      console.log('Setting agent model:', modelValue);
      // Initialize conversation state first
      const conversationId = `conv-${Date.now()}`;
      // Set all options synchronously
      setOption('conversationId')(conversationId);
      setOption('endpointType')('bedrockAgents');
      setOption('endpoint')('bedrockAgents');
      setOption('model')(modelValue);
      
      // Force a re-render by setting the model again after a short delay
      setTimeout(() => {
        setOption('model')(modelValue);
        setOption('conversationId')(conversationId); // Ensure conversationId persists
      }, 100);
      console.log('Agent model set to:', modelValue, 'with conversationId:', conversationId);
    } else {
      console.log('BedrockAgents: Invalid model value:', modelValue);
    }
  };

  const formatAgentOption = (agent: TBedrockAgent): Option => {
    return {
      value: agent.id,
      label: agent.name,
      display: agent.name
    };
  };

  const hasValue = conversation?.model != null && conversation.model !== '';

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
      <div className="relative">
        <SelectDropDown
        value={(() => {
          if (!conversation?.model) {
            return { value: '', label: 'Select Agent', display: 'Select Agent' };
          }
          const foundModel = models.find((model: TBedrockAgent) => model.id === conversation.model);
          if (!foundModel) {
            return { value: '', label: 'Select Agent', display: 'Select Agent' };
          }
          const formattedOption = formatAgentOption(foundModel);
          console.log('Current model value:', formattedOption);
          return formattedOption;
        })()}
        setValue={onSelect}
        availableValues={Array.isArray(models) ? models.map(formatAgentOption) : []}
        showAbove={showAbove}
        showLabel={false}
        className={cn(
          'rounded-md dark:border-gray-700 dark:bg-gray-850',
          'z-50 flex h-[40px] w-full flex-none items-center justify-center px-4 hover:cursor-pointer hover:border-green-500 focus:border-gray-400',
        )}
        optionsClass="hover:bg-gray-20/50 dark:border-gray-700"
        optionsListClass="rounded-lg shadow-lg dark:bg-gray-850 dark:border-gray-700 dark:last:border"
        currentValueClass={cn(
          'text-md font-semibold text-gray-900 dark:text-white',
          !hasValue ? 'text-gray-500' : '',
        )}
        searchPlaceholder={localize('com_agents_search_name')}
        placeholder={`${localize('com_ui_select')} ${localize('com_ui_agent')}`}
        showOptionIcon={true}
      />
      </div>
    </div>
  );
}
