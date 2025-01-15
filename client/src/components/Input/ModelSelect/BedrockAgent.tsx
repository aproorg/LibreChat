import { SelectDropDown, SelectDropDownPop } from '~/components/ui';
import type { TModelSelectProps } from '~/common';
import { useBedrockAgents } from '~/hooks';
import { cn, cardStyle } from '~/utils/';

export default function BedrockAgent({ conversation, setOption, showAbove, popover }: TModelSelectProps) {
  const { data: agents = [] } = useBedrockAgents();

  const SelectComponent = popover ? SelectDropDownPop : SelectDropDown;

  return (
    <SelectComponent
      value={conversation?.agent_id ?? ''}
      setValue={(value: string) => setOption('agent_id', value)}
      availableValues={agents.map((agent) => ({
        value: agent.agentId,
        label: agent.agentName,
        description: agent.description,
      }))}
      showAbove={showAbove}
      className={cn(
        cardStyle,
        'z-50 flex h-[40px] w-48 flex-none items-center justify-center px-4 hover:cursor-pointer',
      )}
      containerClassName="flex w-48"
    />
  );
}
