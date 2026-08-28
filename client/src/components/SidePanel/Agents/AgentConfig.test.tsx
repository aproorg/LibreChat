/**
 * @jest-environment jsdom
 */
import React from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { render, screen } from '@testing-library/react';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { AgentForm } from '~/common';

let mockEndpointsConfig: TEndpointsConfig = {};

jest.mock('@librechat/client', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    Switch: ({ checked }: { checked: boolean }) =>
      ReactModule.createElement('input', { type: 'checkbox', checked, readOnly: true }),
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

jest.mock('@tanstack/react-query', () => ({
  useQueries: () => [],
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({
    actions: [],
    setAction: jest.fn(),
    regularTools: [],
    setActivePanel: jest.fn(),
    endpointsConfig: mockEndpointsConfig,
    agentsConfig: { capabilities: [] },
    availableMCPServers: [],
    mcpServersMap: {},
  }),
  useFileMapContext: () => ({}),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useVisibleTools: () => ({ toolIds: [], mcpServerNames: [] }),
  useHasAccess: () => false,
}));

jest.mock('~/hooks/Agents/useAgentCapabilities', () => ({
  __esModule: true,
  default: () => ({
    codeEnabled: false,
    toolsEnabled: false,
    contextEnabled: false,
    actionsEnabled: false,
    skillsEnabled: false,
    artifactsEnabled: false,
    webSearchEnabled: false,
    fileSearchEnabled: false,
  }),
}));

jest.mock('~/data-provider', () => ({
  useListSkillsQuery: () => ({ data: { skills: [] } }),
  useGetAgentFiles: () => ({ data: [] }),
}));

jest.mock('~/utils', () => ({
  defaultTextProps: '',
  removeFocusOutlines: '',
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getIconKey: () => '',
  getModelDisplayName: (labels: Record<string, string> | undefined, modelId: string) =>
    labels?.[modelId] || modelId || undefined,
  processAgentOption: () => ({ context_files: [], knowledge_files: [], code_files: [] }),
  validateEmail: () => true,
}));

jest.mock('./AgentCategorySelector', () => () => null);
jest.mock('~/components/Tools', () => ({
  ToolSelectDialog: () => null,
  MCPToolSelectDialog: () => null,
}));
jest.mock('~/components/Skills/dialogs', () => ({ SkillSelectDialog: () => null }));
jest.mock('~/components/SidePanel/Builder/Action', () => () => null);
jest.mock('./Instructions', () => () => null);
jest.mock('./FileContext', () => () => null);
jest.mock('./AgentAvatar', () => () => null);
jest.mock('./Search/Form', () => () => null);
jest.mock('./FileSearch', () => () => null);
jest.mock('./Artifacts', () => () => null);
jest.mock('./AgentTool', () => () => null);
jest.mock('./Code/Form', () => () => null);
jest.mock('./MCPTools', () => () => null);

import AgentConfig from './AgentConfig';

function TestForm() {
  const methods = useForm<AgentForm>({
    defaultValues: {
      id: 'agent-id',
      provider: 'Anthropic',
      model: 'claude-opus-4-7',
      name: '',
      description: '',
    },
  });

  return (
    <FormProvider {...methods}>
      <AgentConfig />
      <output data-testid="stored-model">{methods.getValues('model')}</output>
    </FormProvider>
  );
}

describe('AgentConfig model summary', () => {
  beforeEach(() => {
    mockEndpointsConfig = {};
  });

  it('displays the configured model label without changing the stored model id', () => {
    mockEndpointsConfig = {
      Anthropic: {
        order: 0,
        modelLabels: { 'claude-opus-4-7': 'Claude Opus 4.7' },
      },
    };

    render(<TestForm />);

    expect(screen.getByTitle('Claude Opus 4.7')).toHaveTextContent('Claude Opus 4.7');
    expect(screen.getByTestId('stored-model')).toHaveTextContent('claude-opus-4-7');
  });

  it('falls back to the model id when no label is declared', () => {
    render(<TestForm />);

    expect(screen.getByTitle('claude-opus-4-7')).toHaveTextContent('claude-opus-4-7');
  });
});
