import React from 'react';
import { RecoilRoot } from 'recoil';
import { useSetRecoilState } from 'recoil';
import { Provider, createStore } from 'jotai';
import { act, render, waitFor } from '@testing-library/react';
import { LocalStorageKeys, mcpServerToggleKey } from 'librechat-data-provider';
import type { TEphemeralAgent } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { MCPServerDefinition } from '~/hooks/MCP/useMCPServerManager';
import { useApplyAgentToolSwitches } from '../useApplyAgentToolSwitches';
import { cleanupTimestampedStorage } from '~/utils/timestamps';
import { useMCPSelect } from '~/hooks/MCP/useMCPSelect';
import { ephemeralAgentByConvoId } from '~/store';

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
let select: (value: string[]) => void = () => undefined;

function Picker({ conversationId }: { conversationId: string | null }) {
  const { mcpValues, setMCPValues } = useMCPSelect({
    conversationId,
    servers,
    ownsChatSelection: true,
  });
  selected = mcpValues;
  select = setMCPValues;
  return null;
}

function Chat({
  agent,
  conversationId = null,
}: {
  agent: SavedAgent;
  conversationId?: string | null;
}) {
  useApplyAgentToolSwitches({ agent, conversationId });
  return <Picker conversationId={conversationId} />;
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

  it('keeps a default-on server the user turned off once the new chat gets its real id', async () => {
    const store = createStore();
    let applyTemplate: (agent: TEphemeralAgent) => void = () => undefined;
    function TemplateWriter() {
      applyTemplate = useSetRecoilState(ephemeralAgentByConvoId('real1'));
      return null;
    }
    const tree = (conversationId: string | null) => (
      <RecoilRoot>
        <Provider store={store}>
          <TemplateWriter />
          <Chat agent={withToggle('on')} conversationId={conversationId} />
        </Provider>
      </RecoilRoot>
    );
    const { rerender } = render(tree(null));
    await waitFor(() => expect(selected).toEqual([serverName]));

    act(() => select([]));
    await waitFor(() => expect(selected).toEqual([]));

    /** What the SSE handlers do on the first response: copy the submitted state to the real id. */
    act(() => {
      applyTemplate({ mcp: [] });
      rerender(tree('real1'));
    });
    await waitFor(() =>
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_MCP_}real1`)).not.toBeNull(),
    );
    expect(selected).toEqual([]);
    expect(
      JSON.parse(localStorage.getItem(`${LocalStorageKeys.LAST_MCP_}real1`) ?? 'null'),
    ).toEqual([]);
  });

  it('keeps a default-on server the user turned off after the app reloads', async () => {
    let applyTemplate: (agent: TEphemeralAgent) => void = () => undefined;
    function TemplateWriter() {
      applyTemplate = useSetRecoilState(ephemeralAgentByConvoId('real1'));
      return null;
    }
    const store = createStore();
    const tree = (conversationId: string | null) => (
      <RecoilRoot>
        <Provider store={store}>
          <TemplateWriter />
          <Chat agent={withToggle('on')} conversationId={conversationId} />
        </Provider>
      </RecoilRoot>
    );
    const { rerender, unmount } = render(tree(null));
    await waitFor(() => expect(selected).toEqual([serverName]));

    act(() => select([]));
    await waitFor(() => expect(selected).toEqual([]));

    act(() => {
      applyTemplate({ mcp: [] });
      rerender(tree('real1'));
    });
    await waitFor(() =>
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_MCP_}real1`)).not.toBeNull(),
    );
    unmount();

    /** App startup prunes conversation keys without a timestamp. */
    cleanupTimestampedStorage();
    render(
      <RecoilRoot>
        <Provider store={createStore()}>
          <Chat agent={withToggle('on')} conversationId="real1" />
        </Provider>
      </RecoilRoot>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(selected).toEqual([]);
  });
});
