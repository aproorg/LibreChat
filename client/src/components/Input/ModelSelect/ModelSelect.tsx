import { useGetModelsQuery, useListBedrockAgentsQuery } from 'librechat-data-provider/react-query';
import type { TConversation, TBedrockAgent } from 'librechat-data-provider';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TSetOption } from '~/common';
import { multiChatOptions } from './options';

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

  console.log('ModelSelect - Queries:', {
    bedrockAgentsQuery: bedrockAgentsQuery?.data,
    bedrockAgentsStatus: bedrockAgentsQuery?.status,
    bedrockAgentsError: bedrockAgentsQuery?.error,
    modelsQuery: modelsQuery?.data,
  });

  if (!conversation?.endpoint) {
    return null;
  }

  const { endpoint: _endpoint, endpointType } = conversation;
  const endpoint = endpointType ?? _endpoint;
  
  // Use bedrockAgents query for the bedrockAgents endpoint
  const models = endpoint === EModelEndpoint.bedrockAgents
    ? (bedrockAgentsQuery?.data ?? []) as Array<string | TBedrockAgent>
    : modelsQuery?.data?.[_endpoint] ?? [];

  console.log('ModelSelect - Selected models:', {
    endpoint,
    endpointType,
    models,
    isBedrockAgents: endpoint === EModelEndpoint.bedrockAgents
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
