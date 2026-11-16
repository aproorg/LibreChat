import { Constants, ErrorTypes } from 'librechat-data-provider';
import type { AccessLimits } from '~/access';
import { checkAgentAccess, assertAgentAccess, AgentAccessRefusedError } from './access';
import { isFatalAgentInitializationError } from './errors';
import { createAccess } from '~/access';

const limited = (parts: Partial<AccessLimits>) =>
  createAccess(
    {
      specs: new Map(),
      endpoints: new Map(),
      mcpServers: new Map(),
      ...parts,
    },
    { email: 'a@b.is', groups: new Set() },
  );

const only = { users: ['someone@else.is'] };
const mcpTool = `search${Constants.mcp_delimiter}sindri`;

describe('checkAgentAccess', () => {
  it('returns null without access', () => {
    expect(checkAgentAccess({ provider: 'openai', tools: [mcpTool] }, null)).toBeNull();
    expect(checkAgentAccess({ provider: 'openai', tools: [mcpTool] }, undefined)).toBeNull();
  });

  it('refuses a limited provider', () => {
    const access = limited({ endpoints: new Map([['Mistral', only]]) });
    expect(checkAgentAccess({ provider: 'Mistral', tools: [] }, access)).toEqual({
      kind: 'endpoint',
      name: 'Mistral',
    });
  });

  it('refuses a limited MCP server, including the whole-server marker', () => {
    const access = limited({ mcpServers: new Map([['sindri', only]]) });
    const expected = { kind: 'mcpServer', name: 'sindri' };
    expect(checkAgentAccess({ provider: 'openai', tools: [mcpTool] }, access)).toEqual(expected);
    expect(
      checkAgentAccess(
        { provider: 'openai', tools: [`${Constants.mcp_all}${Constants.mcp_delimiter}sindri`] },
        access,
      ),
    ).toEqual(expected);
  });

  it('refuses when the agents endpoint is limited', () => {
    const access = limited({ endpoints: new Map([['agents', only]]) });
    expect(checkAgentAccess({ provider: 'openai', tools: [] }, access)).toEqual({
      kind: 'endpoint',
      name: 'agents',
    });
  });

  it('passes when everything is allowed', () => {
    const access = limited({
      endpoints: new Map([['openai', { users: ['A@B.is '] }]]),
      mcpServers: new Map([['sindri', { users: ['a@b.is'] }]]),
    });
    expect(checkAgentAccess({ provider: 'openai', tools: [mcpTool, 'web_search'] }, access)).toBe(
      null,
    );
  });
});

describe('checkAgentAccess spellings', () => {
  it('refuses a normalized MCP tool key of a limited server with a raw name', () => {
    const access = limited({ mcpServers: new Map([['Jira Cloud', only]]) });
    expect(
      checkAgentAccess(
        { provider: 'openai', tools: [`search${Constants.mcp_delimiter}Jira_Cloud`] },
        access,
      ),
    ).toEqual({ kind: 'mcpServer', name: 'Jira_Cloud' });
  });

  it.each([
    ['Anthropic', 'anthropic'],
    ['openrouter', 'OpenRouter'],
    ['vertexai', 'google'],
    ['VertexAI', 'google'],
  ])('refuses provider %s when %s is limited', (provider, key) => {
    const access = limited({ endpoints: new Map([[key, only]]) });
    expect(checkAgentAccess({ provider, tools: [] }, access)).toEqual({
      kind: 'endpoint',
      name: provider,
    });
  });
});

describe('assertAgentAccess', () => {
  it('throws a fatal AgentAccessRefusedError for a sub-agent on a limited server', () => {
    const access = limited({ mcpServers: new Map([['sindri', only]]) });
    const run = () => assertAgentAccess({ provider: 'openai', tools: [mcpTool] }, access);
    expect(run).toThrow(AgentAccessRefusedError);
    try {
      run();
    } catch (error) {
      expect(isFatalAgentInitializationError(error)).toBe(true);
    }
  });

  it('does nothing without access or when everything is allowed', () => {
    expect(() => assertAgentAccess({ provider: 'openai', tools: [mcpTool] }, null)).not.toThrow();
    expect(() => assertAgentAccess({ provider: 'openai', tools: [] }, limited({}))).not.toThrow();
  });
});

describe('AgentAccessRefusedError', () => {
  it('carries the stable code and status 403 and no names', () => {
    const error = new AgentAccessRefusedError({ kind: 'endpoint', name: 'Mistral' });
    expect(error.code).toBe(ErrorTypes.ACCESS_REFUSED);
    expect(error.status).toBe(403);
    expect(error.message).toBe('access_refused');
  });
});
