import React from 'react';
import { RecoilRoot } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { Tools, mcpServerToggleKey } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import BadgeRow from '../BadgeRow';

let mockAgent: Partial<Agent> | undefined;
let mockContext: Record<string, unknown> = {};
const mockApplySwitches = jest.fn();
const mockProvider = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
  useGetAgentByIdQuery: () => ({ data: mockAgent }),
}));

jest.mock('~/hooks', () => ({
  useChatBadges: () => [],
  useApplyAgentToolSwitches: (args: unknown) => mockApplySwitches(args),
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useAuthContext: () => ({ user: undefined }),
  useHasMemoryAccess: () => false,
  useAgentCapabilities: () => ({
    codeEnabled: true,
    memoryEnabled: true,
    webSearchEnabled: true,
    artifactsEnabled: false,
    fileSearchEnabled: true,
    skillsEnabled: true,
  }),
}));

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => mockContext,
  BadgeRowProvider: (props: { children: React.ReactNode }) => {
    mockProvider(props);
    return <>{props.children}</>;
  },
}));

jest.mock('~/components/Chat/Input/MCPSubMenu', () => ({
  __esModule: true,
  default: () => <div data-testid="mcp-submenu" />,
}));
jest.mock('~/components/Chat/Input/ArtifactsSubMenu', () => ({
  __esModule: true,
  default: () => null,
}));

const stub = (testId: string) => ({
  __esModule: true,
  default: () => <div data-testid={testId} />,
});
jest.mock('../CodeInterpreter', () => stub('code-badge'));
jest.mock('../FileSearch', () => stub('file-badge'));
jest.mock('../WebSearch', () => stub('web-badge'));
jest.mock('../MCPSelect', () => stub('mcp-badge'));
jest.mock('../Artifacts', () => stub('artifacts-badge'));
jest.mock('../Memory', () => stub('memory-badge'));
jest.mock('../Skills', () => stub('skills-badge'));
jest.mock('../ToolDialogs', () => stub('tool-dialogs'));

const savedAgent: Partial<Agent> = {
  id: 'agent_1',
  tools: [Tools.web_search, Tools.execute_code, 'search_mcp_docs'],
  tool_options: {
    [Tools.web_search]: { user_toggle: 'on' },
    [mcpServerToggleKey('docs')]: { user_toggle: 'off' },
  },
};

const renderRow = (props: Partial<React.ComponentProps<typeof BadgeRow>>) =>
  render(
    <RecoilRoot>
      <BadgeRow onChange={jest.fn()} isInChat={false} conversationId="convo_1" {...props} />
    </RecoilRoot>,
  );

describe('BadgeRow agent switches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgent = savedAgent;
    mockContext = {};
  });

  it('shows only the switchable tools of a saved agent and seeds their defaults', () => {
    renderRow({ agentId: 'agent_1', showEphemeralBadges: false });

    expect(screen.getByTestId('web-badge')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('code-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skills-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('memory-badge')).not.toBeInTheDocument();
    expect(mockApplySwitches).toHaveBeenCalledWith({
      agent: savedAgent,
      conversationId: 'convo_1',
    });
    expect(mockProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        agentToolSwitches: { builtins: { [Tools.web_search]: true }, mcp: { docs: false } },
      }),
    );
  });

  it('renders no switch badges for a saved agent without switches', () => {
    mockAgent = { id: 'agent_1', tools: [Tools.web_search] };
    renderRow({ agentId: 'agent_1', showEphemeralBadges: false });

    expect(screen.queryByTestId('web-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-badge')).not.toBeInTheDocument();
  });

  it('keeps the full badge set for ephemeral chats', () => {
    renderRow({ showEphemeralBadges: true });

    for (const testId of ['web-badge', 'code-badge', 'file-badge', 'skills-badge', 'mcp-badge']) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
    expect(mockProvider).toHaveBeenCalledWith(
      expect.objectContaining({ agentToolSwitches: undefined }),
    );
  });
});

describe('ToolsDropdown agent switches', () => {
  const renderDropdown = async () => {
    const ToolsDropdown = jest.requireActual('../ToolsDropdown').default;
    render(
      <main>
        <ToolsDropdown />
      </main>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Tools Options' }));
  };

  it('lists only the switchable tools for a saved agent', async () => {
    mockContext = {
      agentToolSwitches: { builtins: { [Tools.web_search]: true }, mcp: {} },
      webSearch: {},
      codeInterpreter: {},
      fileSearch: {},
      skills: {},
      memory: {},
      mcpServerManager: { availableMCPServers: [] },
    };
    await renderDropdown();

    expect(await screen.findByText('com_ui_web_search')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_run_code')).not.toBeInTheDocument();
    expect(screen.queryByText('com_assistants_file_search')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-submenu')).not.toBeInTheDocument();
  });

  it('lists every enabled tool without agent switches', async () => {
    mockContext = {
      webSearch: {},
      codeInterpreter: {},
      fileSearch: {},
      skills: {},
      memory: {},
      mcpServerManager: { availableMCPServers: [{ serverName: 'docs' }] },
    };
    await renderDropdown();

    expect(await screen.findByText('com_ui_web_search')).toBeInTheDocument();
    expect(screen.getByText('com_ui_run_code')).toBeInTheDocument();
    expect(screen.getByText('com_assistants_file_search')).toBeInTheDocument();
    expect(screen.getByText('com_ui_skills')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-submenu')).toBeInTheDocument();
  });
});
