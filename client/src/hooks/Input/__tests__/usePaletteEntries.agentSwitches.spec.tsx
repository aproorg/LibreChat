import React from 'react';
import { RecoilRoot } from 'recoil';
import { Tools } from 'librechat-data-provider';
import { renderHook } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import type { AgentToolSwitches } from 'librechat-data-provider';
import usePaletteEntries from '../usePaletteEntries';

/**
 * In a saved agent's chat the palette offers only the built-ins its creator made
 * switchable, never the ephemeral-only toggles, and only the switchable servers.
 */

let mockContext: Record<string, unknown>;

jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useHasMemoryAccess: () => true,
  useAuthContext: () => ({ user: { personalization: { memories: true } } }),
  useAgentCapabilities: () => ({
    codeEnabled: true,
    memoryEnabled: true,
    webSearchEnabled: true,
    artifactsEnabled: true,
    fileSearchEnabled: true,
    skillsEnabled: true,
  }),
  useSkillActiveState: () => ({ isActive: () => true }),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => mockContext,
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/data-provider', () => ({
  useSkillsInfiniteQuery: () => ({
    data: { pages: [{ skills: [] }] },
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
    refetch: jest.fn(),
  }),
}));

const toggle = (state: unknown = false) => ({
  toggleState: state,
  isPinned: false,
  debouncedChange: jest.fn(),
  setIsPinned: jest.fn(),
});

const fullContext = (agentToolSwitches?: AgentToolSwitches) => ({
  webSearch: toggle(),
  codeInterpreter: toggle(),
  fileSearch: toggle(),
  skills: toggle(),
  memory: toggle(),
  artifacts: toggle(''),
  agentToolSwitches,
  mcpServerManager: {
    /* Mirrors BadgeRowContext, which scopes the servers to the agent's switches. */
    selectableServers: [{ serverName: 'docs' }, { serverName: 'other' }].filter(
      ({ serverName }) => agentToolSwitches == null || serverName in agentToolSwitches.mcp,
    ),
    mcpValues: [],
    toggleServerSelection: jest.fn(),
  },
  agentsConfig: { capabilities: [] },
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <JotaiProvider store={createStore()}>
    <RecoilRoot>{children}</RecoilRoot>
  </JotaiProvider>
);

const keys = (toolsEnabled?: boolean) =>
  renderHook(() => usePaletteEntries({ conversationId: 'convo-1', toolsEnabled }), {
    wrapper,
  }).result.current.map((item) => item.key);

describe('usePaletteEntries agent tool switches', () => {
  it('offers only the switchable built-ins and drops skills, memory and artifacts', () => {
    mockContext = fullContext({ builtins: { [Tools.web_search]: true }, mcp: {} });

    expect(keys()).toEqual(['builtin:web_search']);
  });

  it('offers the switchable built-ins even when endpoint tools are hidden', () => {
    mockContext = fullContext({ builtins: { [Tools.web_search]: true }, mcp: {} });

    expect(keys(false)).toEqual(['builtin:web_search']);
  });

  it('lists the MCP servers the provider scoped to the agent switches', () => {
    const context = fullContext({ builtins: {}, mcp: { docs: false } });
    context.mcpServerManager.selectableServers = [{ serverName: 'docs' }];
    mockContext = context;

    expect(keys()).toEqual(['mcp:docs']);
  });

  it('leaves the full upstream list without agent switches', () => {
    mockContext = fullContext();

    expect(keys()).toEqual([
      'builtin:web_search',
      'builtin:execute_code',
      'builtin:file_search',
      'builtin:skills',
      'builtin:memory',
      'builtin:artifacts',
      'mcp:docs',
      'mcp:other',
    ]);
  });
});
