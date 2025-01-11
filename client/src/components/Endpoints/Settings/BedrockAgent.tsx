import { useCallback, useMemo } from 'react';
import { useListBedrockAgentsQuery } from 'librechat-data-provider/react-query';
import { useLocalize } from '~/hooks';
import type { TModelSelectProps } from '~/common';
import { Input, SelectDropDown } from '~/components/ui';

export default function Settings({ conversation, setOption, readonly }: TModelSelectProps) {
  const localize = useLocalize();
  const { data: agents = [] } = useListBedrockAgentsQuery();

  const onAgentChange = useCallback(
    (value: string) => {
      setOption('agentId', value);
      const selectedAgent = agents.find((agent) => agent.id === value);
      if (selectedAgent) {
        setOption('modelLabel', selectedAgent.name);
      }
    },
    [setOption, agents],
  );

  const onAgentAliasIdChange = useCallback(
    (value: string) => {
      setOption('agentAliasId', value);
    },
    [setOption],
  );

  const onRegionChange = useCallback(
    (value: string) => {
      setOption('region', value);
    },
    [setOption],
  );

  const agentOptions = agents.map((agent) => ({
    value: agent.id,
    label: `${agent.name} (${agent.id})`,
  }));

  const parameters = useMemo(
    () => [
      {
        label: 'Agent',
        value: conversation?.agentId ?? '',
        type: 'select',
        name: 'agentId',
        onChange: onAgentChange,
        options: agentOptions,
      },
      {
        label: 'Agent Alias ID',
        value: conversation?.agentAliasId ?? '',
        type: 'text',
        name: 'agentAliasId',
        onChange: onAgentAliasIdChange,
      },
      {
        label: 'Region',
        value: conversation?.region ?? 'eu-central-1',
        type: 'text',
        name: 'region',
        onChange: onRegionChange,
      },
    ],
    [conversation, onAgentChange, onAgentAliasIdChange, onRegionChange, agentOptions],
  );

  return (
    <div className="flex w-full flex-col gap-2">
      {parameters.map((param) => (
        <div className="flex flex-col gap-1" key={param.name}>
          <label className="text-sm font-medium">{localize(param.label)}</label>
          {param.type === 'select' ? (
            <SelectDropDown
              value={param.value}
              setValue={param.onChange}
              availableValues={param.options}
              disabled={readonly}
            />
          ) : (
            <Input
              type={param.type}
              value={param.value}
              onChange={(e) => param.onChange(e.target.value)}
              disabled={readonly}
            />
          )}
        </div>
      ))}
    </div>
  );
}
