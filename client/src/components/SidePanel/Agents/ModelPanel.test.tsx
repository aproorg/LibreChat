/**
 * @jest-environment jsdom
 */
import React from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { render } from '@testing-library/react';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import ModelPanel from './ModelPanel';

let mockEndpointsConfig: TEndpointsConfig = {};

jest.mock('@librechat/client', () => ({
  ControlCombobox: ({
    ariaLabel,
    items,
    selectedValue,
    displayValue,
  }: {
    ariaLabel: string;
    items: Array<{ label: string; value: string }>;
    selectedValue: string;
    displayValue?: string;
  }) => (
    <div>
      <span data-testid={`${ariaLabel}-selected`}>{selectedValue}</span>
      <span data-testid={`${ariaLabel}-display`}>{displayValue}</span>
      {items.map((item) => (
        <span key={item.value} data-testid={`${ariaLabel}-${item.value}`}>
          {item.label}
        </span>
      ))}
    </div>
  ),
}));

jest.mock('~/components/SidePanel/Parameters/components', () => ({
  componentMapping: {},
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
}));

jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getModelLabel: (labels?: Record<string, string>, id?: string) => labels?.[id ?? '']?.trim(),
}));

function TestForm() {
  const methods = useForm<AgentForm>({
    defaultValues: {
      provider: 'custom',
      model: 'custom-model',
      model_parameters: {},
    },
  });

  return (
    <FormProvider {...methods}>
      <ModelPanel
        providers={[{ label: 'Custom', value: 'custom' }]}
        models={{ custom: ['custom-model'] }}
        setActivePanel={jest.fn()}
      />
    </FormProvider>
  );
}

describe('ModelPanel model labels', () => {
  beforeEach(() => {
    localStorage.clear();
    mockEndpointsConfig = {};
  });

  it('displays a configured label while retaining the model id', () => {
    mockEndpointsConfig = {
      custom: { order: 0, modelLabels: { 'custom-model': ' Custom Model ' } },
    };

    const { getByTestId } = render(<TestForm />);

    expect(getByTestId('com_ui_model-display')).toHaveTextContent('Custom Model');
    expect(getByTestId('com_ui_model-selected')).toHaveTextContent('custom-model');
    expect(getByTestId('com_ui_model-custom-model')).toHaveTextContent('Custom Model');
  });
});
