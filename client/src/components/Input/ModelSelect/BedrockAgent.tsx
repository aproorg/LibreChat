import { SelectDropDown, SelectDropDownPop } from '~/components/ui';
import { useListBedrockAgentsQuery } from 'librechat-data-provider/react-query';
import type { TModelSelectProps } from '~/common';
import { cn, cardStyle } from '~/utils/';

export default function BedrockAgent({
  conversation,
  setOption,
  showAbove = true,
  popover = false,
}: TModelSelectProps) {
  const Menu = popover ? SelectDropDownPop : SelectDropDown;
  const { data } = useListBedrockAgentsQuery();
  const agents = data?.agents ?? [];

  const agentOptions = agents.map((agent) => ({
    value: agent.id,
    label: agent.name || agent.id,
  }));

  const selectedAgent = agents.find((agent) => agent.id === conversation?.agentId);

  return (
    <Menu
      value={conversation?.agentId ?? ''}
      setValue={(value: string) => {
        setOption('agentId', value);
        const selectedAgent = agents.find((agent) => agent.id === value);
        if (selectedAgent) {
          setOption('model', 'bedrock-agent');
          setOption('modelLabel', selectedAgent.name);
        }
      }}
      availableValues={agentOptions.map(opt => opt.value)}
      optionLabels={Object.fromEntries(agentOptions.map(opt => [opt.value, opt.label]))}
      showAbove={showAbove}
      className={cn(
        cardStyle,
        'z-50 flex h-[40px] w-48 flex-none items-center justify-center px-4 hover:cursor-pointer',
      )}
      text={selectedAgent?.name || 'Select Agent'}
    />
  );
}
