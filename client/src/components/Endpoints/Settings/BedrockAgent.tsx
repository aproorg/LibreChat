import { useCallback, useMemo } from 'react';
import { useLocalize } from '~/hooks';
import type { TModelSelectProps } from '~/common';
import { Input } from '~/components/ui';

export default function Settings({ conversation, setOption, readonly }: TModelSelectProps) {
  const localize = useLocalize();

  const onAgentIdChange = useCallback(
    (value: string) => {
      setOption('agentId', value);
    },
    [setOption],
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

  const parameters = useMemo(
    () => [
      {
        label: 'Agent ID',
        value: conversation?.agentId ?? '',
        type: 'text',
        name: 'agentId',
        onChange: onAgentIdChange,
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
    [conversation, onAgentIdChange, onAgentAliasIdChange, onRegionChange],
  );

  return (
    <div className="flex w-full flex-col gap-2">
      {parameters.map((param) => (
        <div className="flex flex-col gap-1" key={param.name}>
          <label className="text-sm font-medium">{localize(param.label)}</label>
          <Input
            type={param.type}
            value={param.value}
            onChange={(e) => param.onChange(e.target.value)}
            disabled={readonly}
          />
        </div>
      ))}
    </div>
  );
}
