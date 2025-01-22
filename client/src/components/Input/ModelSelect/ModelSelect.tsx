import { useGetModelsQuery, useListBedrockAgentsQuery } from 'librechat-data-provider/react-query';
import type { TConversation } from 'librechat-data-provider';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TSetOption } from '~/common';
import { multiChatOptions } from './options';
import React, { useEffect } from 'react';

type TGoogleProps = {
  showExamples: boolean;
  isCodeChat: boolean;
};

type TSelectProps = {
  conversation: TConversation | null;
  setOption: TSetOption;
  extraProps?: TGoogleProps;
  showAbove?: boolean;
  popover?: boolean;
};

export default function ModelSelect({
  conversation,
  setOption,
  popover = false,
  showAbove = true,
}: TSelectProps) {
  const modelsQuery = useGetModelsQuery();
  const bedrockAgentsQuery = useListBedrockAgentsQuery();

  if (!conversation?.endpoint) {
    return null;
  }

  const { endpoint: _endpoint, endpointType } = conversation;
  
  // Simplify endpoint mapping - treat 'agents' as 'bedrockAgents'
  const endpoint = (_endpoint === 'agents' || endpointType === 'agents') 
    ? EModelEndpoint.bedrockAgents 
    : (endpointType ?? _endpoint);

  // Use bedrockAgents query for agents endpoints
  const isBedrockAgents = endpoint === EModelEndpoint.bedrockAgents;
  const models = isBedrockAgents
    ? bedrockAgentsQuery?.data ?? []
    : modelsQuery?.data?.[_endpoint] ?? [];

  // Debug logs for component state
  console.log('ModelSelect Component State:', {
    endpoint,
    _endpoint,
    endpointType,
    isBedrockAgents,
    models,
    bedrockAgentsData: bedrockAgentsQuery?.data,
    conversation,
    hasModels: models.length > 0,
    isLoading: bedrockAgentsQuery.isLoading,
    isError: bedrockAgentsQuery.isError,
    error: bedrockAgentsQuery.error
  });

  // Handle endpoint switch in useEffect to prevent state updates during render
  useEffect(() => {
    if (_endpoint === 'agents' && bedrockAgentsQuery?.data?.length && !conversation?.model) {
      console.log('Initializing Bedrock Agents:', {
        currentEndpoint: _endpoint,
        availableAgents: bedrockAgentsQuery.data,
        conversation
      });
      // Initialize conversation state for Bedrock Agents
      const conversationId = conversation?.conversationId || `conv-${Date.now()}`;
      React.startTransition(() => {
        setOption('endpoint')(EModelEndpoint.bedrockAgents);
        setOption('endpointType')(EModelEndpoint.bedrockAgents);
        setOption('conversationId')(conversationId);
      });
    }
  }, [_endpoint, bedrockAgentsQuery?.data, setOption, conversation?.model]);

  const OptionComponent = multiChatOptions[endpoint];

  if (!OptionComponent) {
    return null;
  }

  return (
    <OptionComponent
      conversation={conversation}
      setOption={setOption}
      models={models}
      showAbove={showAbove}
      popover={popover}
    />
  );
}
