/** @jest-environment jsdom */
import { FormProvider, useForm } from 'react-hook-form';
import { render, screen, waitFor } from '@testing-library/react';
import type { AgentForm } from '~/common';
import { composeAgentUpdatePayload } from '../AgentPanel';
import CodeSettings from '../Code/Settings';

let mockAgentsConfig: Record<string, unknown> | undefined;
jest.mock('~/data-provider', () => ({
  useCodeEnvironmentStatusQueries: () => [],
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: {} }),
  useGetAgentsConfig: () => ({ agentsConfig: mockAgentsConfig }),
}));

const config = (extra: Record<string, unknown> = {}) => ({
  capabilities: ['stateful_code_sessions'],
  statefulCodeSessions: { allowedEnvironments: ['user', 'agent-user', 'conversation'] },
  ...extra,
});

let form: ReturnType<typeof useForm<AgentForm>>;
function Harness({ values }: { values: Partial<AgentForm> }) {
  form = useForm<AgentForm>({ defaultValues: { provider: 'openAI', model: 'gpt-4', ...values } });
  return (
    <FormProvider {...form}>
      <CodeSettings />
    </FormProvider>
  );
}

afterEach(() => {
  mockAgentsConfig = undefined;
});

describe.each([
  ['code on, flag unset', {}],
  ['saved agent with stateful_code_sessions false', { stateful_code_sessions: false }],
])('codeDefaultProfile stateful, %s', (_name, saved) => {
  beforeEach(() => {
    mockAgentsConfig = config({ codeDefaultProfile: 'stateful' });
  });

  it('hides the switch, shows the options, and forces the form value', async () => {
    render(<Harness values={{ execute_code: true, ...saved }} />);
    expect(screen.queryByTestId('stateful-code-sessions')).toBeNull();
    expect(screen.getByRole('group', { name: 'com_ui_stateful_sessions' })).toBeInTheDocument();
    expect(screen.getByTestId('stateful-code-environment')).toBeInTheDocument();
    await waitFor(() => expect(form.getValues('stateful_code_sessions')).toBe(true));
    expect(form.getValues('stateful_code_environment')).toBe('user');
    expect(form.formState.dirtyFields.stateful_code_sessions).toBeUndefined();
    expect(form.formState.dirtyFields.stateful_code_environment).toBeUndefined();
  });

  it('saves stateful_code_sessions true when execute_code is on', async () => {
    render(<Harness values={{ execute_code: true, ...saved }} />);
    await waitFor(() => expect(form.getValues('stateful_code_sessions')).toBe(true));
    const { payload } = composeAgentUpdatePayload(form.getValues(), 'agent_1');
    expect(payload.stateful_code_sessions).toBe(true);
  });
});

it('shows no switch while code execution is off under the deployment default', () => {
  mockAgentsConfig = config({ codeDefaultProfile: 'stateful' });
  render(<Harness values={{ execute_code: false, stateful_code_sessions: false }} />);
  expect(screen.queryByTestId('stateful-code-sessions')).toBeNull();
  expect(form.getValues('stateful_code_sessions')).toBe(false);
});

it.each([[undefined], ['default']])(
  'renders the switch off and hides options when codeDefaultProfile is %s',
  (profile) => {
    mockAgentsConfig = config(profile ? { codeDefaultProfile: profile } : {});
    render(<Harness values={{ execute_code: true, stateful_code_sessions: false }} />);
    expect(screen.getByTestId('stateful-code-sessions')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('stateful-code-environment')).toBeNull();
    expect(form.getValues('stateful_code_sessions')).toBe(false);
  },
);

it('renders nothing when the stateful capability is off', () => {
  mockAgentsConfig = { capabilities: [], codeDefaultProfile: 'stateful' };
  const { container } = render(<Harness values={{ execute_code: true }} />);
  expect(container).toBeEmptyDOMElement();
  expect(form.getValues('stateful_code_sessions')).toBeUndefined();
});
