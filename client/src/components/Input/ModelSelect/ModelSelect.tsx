import { useGetModelsQuery, useListBedrockAgentsQuery } from 'librechat-data-provider/react-query';
import type { TConversation } from 'librechat-data-provider';
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

  if (!conversation?.endpoint) {
    return null;
  }

  const { endpoint: _endpoint, endpointType } = conversation;
  const endpoint = endpointType ?? _endpoint;
  
  // Use bedrockAgents query for the bedrockAgents endpoint
  const models = endpoint === EModelEndpoint.bedrockAgents
    ? bedrockAgentsQuery?.data?.bedrockAgents ?? []
    : modelsQuery?.data?.[_endpoint] ?? [];

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
