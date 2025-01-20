import React from 'react';
import type { TModelSelectProps, Option } from '~/common/types';
import type { TBedrockAgent } from 'librechat-data-provider';
import { EModelEndpoint } from 'librechat-data-provider';
import useLocalize from '~/hooks/useLocalize';
import cn from '~/utils/cn';
import SelectDropDown from '~/components/ui/SelectDropDown';

type BedrockOption = {
  value: string;
  label: string;
  display: string;
};

export default function BedrockAgents({
  conversation,
  setOption,
  models,
  showAbove = true,
  popover = false,
}: TModelSelectProps & { models: Array<string | TBedrockAgent> }) {
  const localize = useLocalize();

  const onSelect = (value: string | Option) => {
    if (!value) {
      return;
    }
    console.log('BedrockAgents - onSelect value:', value);
    const modelValue = typeof value === 'object' ? value.value : value;
    if (modelValue) {
      console.log('BedrockAgents - Setting agent model:', modelValue);
      setOption('endpointType')(EModelEndpoint.bedrockAgents);
      setOption('endpoint')(EModelEndpoint.bedrockAgents);
      setOption('model')(modelValue);
      console.log('BedrockAgents - Agent model set to:', modelValue);
    }
  };

  const formatAgentOption = (agent: string | TBedrockAgent): Option => {
    if (typeof agent === 'string') {
      return {
        value: agent,
        label: agent,
      };
    }
    return {
      value: agent.id,
      label: agent.name,
    };
  };

  const hasValue = conversation?.model != null && conversation.model !== '';

  console.log('BedrockAgents - Props:', {
    conversation,
    models,
    hasValue,
    formattedModels: Array.isArray(models) ? models.map(formatAgentOption) : []
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
      <div className="relative">
        <SelectDropDown
        value={(() => {
          if (!conversation?.model) return null;
          const foundModel = models.find((model: string | TBedrockAgent) => 
            (typeof model === 'object' && 'id' in model) 
              ? model.id === conversation.model
              : model === conversation.model
          );
          if (!foundModel) return null;
          return formatAgentOption(foundModel);
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
