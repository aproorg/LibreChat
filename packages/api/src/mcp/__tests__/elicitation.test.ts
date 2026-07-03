import {
  asElicitationFlowManager,
  generateElicitationFlowId,
  parseElicitationFlowId,
} from '~/mcp/elicitation';

describe('elicitation flow IDs', () => {
  it('round-trips the userId, serverName, and toolName it was built from', () => {
    const flowId = generateElicitationFlowId('user-1', 'jira_server', 'create_issue');

    expect(parseElicitationFlowId(flowId)).toEqual({
      userId: 'user-1',
      serverName: 'jira_server',
      toolName: 'create_issue',
      nonce: expect.any(String),
      tenantId: undefined,
    });
  });

  it('preserves a colon inside a segment instead of skewing the parsed fields', () => {
    const flowId = generateElicitationFlowId('user-1', 'ns:jira', 'do:thing');
    const parsed = parseElicitationFlowId(flowId);

    expect(parsed?.serverName).toBe('ns:jira');
    expect(parsed?.toolName).toBe('do:thing');
    expect(parsed?.userId).toBe('user-1');
  });

  it('round-trips the tenantId for tenant-scoped flows', () => {
    const flowId = generateElicitationFlowId('user-1', 'jira_server', 'create_issue', 'acme:eu');
    const parsed = parseElicitationFlowId(flowId);

    expect(parsed?.tenantId).toBe('acme:eu');
    expect(parsed?.serverName).toBe('jira_server');
  });

  it('generates a distinct ID per invocation so concurrent calls never collide', () => {
    const a = generateElicitationFlowId('user-1', 'jira_server', 'create_issue');
    const b = generateElicitationFlowId('user-1', 'jira_server', 'create_issue');

    expect(a).not.toBe(b);
  });

  it('returns null for IDs with too few segments', () => {
    expect(parseElicitationFlowId('user-1:jira_server')).toBeNull();
    expect(parseElicitationFlowId('tenant:acme:user-1')).toBeNull();
  });
});

describe('asElicitationFlowManager', () => {
  it('re-views the same manager instance without copying it', () => {
    const manager = { createFlow: jest.fn(), completeFlow: jest.fn() };

    expect(asElicitationFlowManager(manager)).toBe(manager);
  });
});
