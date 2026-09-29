import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { render, waitFor } from '@testing-library/react';
import { mcpServerToggleKey } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { MCPServerDefinition } from '~/hooks/MCP/useMCPServerManager';
import { useApplyAgentToolSwitches } from '../useApplyAgentToolSwitches';
import { useMCPSelect } from '~/hooks/MCP/useMCPSelect';

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetStartupConfig: jest.fn(() => ({ data: undefined })),
}));

const serverName = 'mock-elicitation';
const servers = [
  { serverName, config: { type: 'sse', url: 'http://localhost' }, effectivePermissions: 1 },
] as unknown as MCPServerDefinition[];

type SavedAgent = Pick<Agent, 'id' | 'tools' | 'tool_options'>;

const withToggle = (toggle?: 'on' | 'off'): SavedAgent => ({
  id: 'agent_1',
  tools: [`echo_mcp_${serverName}`],
  tool_options: toggle ? { [mcpServerToggleKey(serverName)]: { user_toggle: toggle } } : {},
});

let selected: string[] = [];

function Picker() {
  const { mcpValues } = useMCPSelect({ conversationId: null, servers, ownsChatSelection: true });
  selected = mcpValues;
  return null;
}

function Chat({ agent }: { agent: SavedAgent }) {
  useApplyAgentToolSwitches({ agent, conversationId: null });
  return <Picker />;
}

describe('useApplyAgentToolSwitches', () => {
  beforeEach(() => {
    localStorage.clear();
    selected = [];
  });

  it('selects a default-on MCP server in a new chat', async () => {
    render(
      <RecoilRoot>
        <Provider store={createStore()}>
          <Chat agent={withToggle('on')} />
        </Provider>
      </RecoilRoot>,
    );
    await waitFor(() => expect(selected).toEqual([serverName]));
  });

  it.each([
    ['not switchable', undefined],
    ['switchable, starts off', 'off' as const],
  ])(
    'selects a default-on MCP server once the saved agent changes from %s',
    async (_label, previousToggle) => {
      const store = createStore();
      const tree = (agent: SavedAgent) => (
        <RecoilRoot>
          <Provider store={store}>
            <Chat agent={agent} />
          </Provider>
        </RecoilRoot>
      );
      const { rerender } = render(tree(withToggle(previousToggle)));
      await waitFor(() => expect(selected).toEqual([]));

      rerender(tree(withToggle('on')));
      await waitFor(() => expect(selected).toEqual([serverName]));
    },
  );
});
