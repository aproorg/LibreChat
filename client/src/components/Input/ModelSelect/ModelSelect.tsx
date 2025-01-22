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
  const endpoint = endpointType ?? _endpoint;
  
  // Use bedrockAgents query for the bedrockAgents endpoint
  const isBedrockAgents = endpoint === EModelEndpoint.bedrockAgents;
  const models = isBedrockAgents
    ? bedrockAgentsQuery?.data ?? []
    : modelsQuery?.data?.[_endpoint] ?? [];

  // Handle endpoint switch in useEffect to prevent state updates during render
  useEffect(() => {
    if (_endpoint === 'bedrock' && bedrockAgentsQuery?.data?.length) {
      React.startTransition(() => {
        setOption('endpoint')('bedrockAgents');
        setOption('endpointType')('bedrockAgents');
      });
    }
  }, [_endpoint, bedrockAgentsQuery?.data, setOption]);
  console.log('ModelSelect Debug:', {
    endpoint,
    bedrockAgentsData: bedrockAgentsQuery?.data,
    modelsData: modelsQuery?.data,
    finalModels: models,
    conversation
  });

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
