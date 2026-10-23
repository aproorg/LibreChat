/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
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
  componentMapping: {
    /** Renders the setting key so a test can assert which parameters the panel
     *  offered. The other suites pass `componentMapping: {}` semantics through
     *  `settingKey`-free assertions, so this stays inert for them. */
    switch: ({ settingKey }: { settingKey: string }) => <div data-testid={`param-${settingKey}`} />,
  },
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
}));

jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: jest.fn() }),
}));

const mockHasWebSearchAccess = jest.fn(() => true);
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => mockHasWebSearchAccess(),
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

function WebSearchTestForm() {
  const methods = useForm<AgentForm>({
    defaultValues: {
      provider: 'openAI',
      model: 'gpt-4o',
      model_parameters: {},
    },
  });

  return (
    <FormProvider {...methods}>
      <ModelPanel
        providers={[{ label: 'OpenAI', value: 'openAI' }]}
        models={{ openAI: ['gpt-4o'] }}
        setActivePanel={jest.fn()}
      />
    </FormProvider>
  );
}

describe('ModelPanel web search parameter gating', () => {
  beforeEach(() => {
    localStorage.clear();
    mockEndpointsConfig = {};
  });

  afterEach(() => {
    mockHasWebSearchAccess.mockReturnValue(true);
  });

  /** `web_search` is a model parameter as well as a tool, so the builder offering
   *  the switch to a role the server refuses is the same gap one panel over. */
  it('renders the web_search switch when the role grants WEB_SEARCH', () => {
    const { queryAllByTestId } = render(<WebSearchTestForm />);
    expect(queryAllByTestId('param-web_search').length).toBeGreaterThan(0);
  });

  it('hides the web_search switch when the role denies WEB_SEARCH', () => {
    mockHasWebSearchAccess.mockReturnValue(false);
    const { queryAllByTestId } = render(<WebSearchTestForm />);
    expect(queryAllByTestId('param-web_search')).toHaveLength(0);
  });
});
