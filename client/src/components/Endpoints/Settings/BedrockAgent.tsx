import { useMemo } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { useBedrockAgents } from '~/hooks';
import type { TModelSelectProps } from '~/common';
import { SelectDropDown, InputNumber } from '../../ui';
import OptionHover from './OptionHover';
import { useLocalize } from '../../../hooks';
import { cn } from '../../../utils';
import { Slider } from '../../ui/Slider';

export default function Settings({ conversation, setOption, models, readonly }: TModelSelectProps) {
  const localize = useLocalize();

  const { data: agents = [] } = useBedrockAgents();

  const parameters = useMemo(() => {
    return [
      {
        type: 'select',
        label: localize('com_endpoint_agent_select'),
        description: localize('com_endpoint_agent_select_helper'),
        value: conversation?.agent_id ?? '',
        options: agents.map((agent) => ({
          label: agent.agentName,
          value: agent.agentId,
          description: agent.description,
        })) ?? [],
        onChange: (value: string) => setOption('agent_id', value),
      },
      {
        type: 'slider',
        label: localize('com_endpoint_temperature'),
        description: localize('com_endpoint_temperature_helper'),
        value: conversation?.temperature ?? 1,
        min: 0,
        max: 1,
        step: 0.01,
        onChange: (value: number) => setOption('temperature', value),
        component: Slider,
      },
      {
        type: 'number',
        label: localize('com_endpoint_max_output'),
        description: localize('com_endpoint_max_output_helper'),
        value: conversation?.maxOutputTokens ?? 4096,
        min: 1,
        max: 4096,
        step: 1,
        onChange: (value: number) => setOption('maxOutputTokens', value),
      },
    ];
  }, [conversation, models, setOption, localize]);

  return (
    <div className="grid grid-cols-5 gap-6">
      {parameters.map((param, i) => {
        const key = `${param.type}-${i}`;
        return (
          <div
            key={key}
            className={cn(
              'col-span-5 flex flex-col gap-2',
              param.type === 'slider' ? 'lg:col-span-3' : '',
              param.type === 'number' ? 'lg:col-span-2' : '',
            )}
          >
            <div className="flex items-center justify-between">
              <OptionHover
                title={param.label}
                description={param.description ?? ''}
              />
            </div>
            {param.type === 'select' && (
              <SelectDropDown
                value={param.value}
                onChange={param.onChange}
                options={param.options}
                readonly={readonly}
              />
            )}
            {param.type === 'slider' && (
              <param.component
                value={param.value}
                min={param.min}
                max={param.max}
                step={param.step}
                onValueChange={param.onChange}
                disabled={readonly}
              />
            )}
            {param.type === 'number' && (
              <InputNumber
                value={param.value}
                min={param.min}
                max={param.max}
                step={param.step}
                onChange={param.onChange}
                disabled={readonly}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
