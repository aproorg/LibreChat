import {
  asElicitationFlowManager,
  extractUrlElicitation,
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

describe('MCPConnection.setElicitationHandler disposal', () => {
  // Exercises the real method against a stubbed SDK client: registration is
  // last-writer-wins (the protocol offers no call correlation), but disposal is
  // token-guarded — an earlier call settling must never tear down a later
  // call's live handler.
  const { MCPConnection } = jest.requireActual<typeof import('../connection')>('../connection');

  const makeFakeConnection = () => {
    const client = { setRequestHandler: jest.fn(), removeRequestHandler: jest.fn() };
    return { client, connection: { client } as unknown as InstanceType<typeof MCPConnection> };
  };
  const handler = () => Promise.resolve({ action: 'accept' as const });

  it('removes the handler when the registering call settles last', () => {
    const { client, connection } = makeFakeConnection();
    const dispose = MCPConnection.prototype.setElicitationHandler.call(connection, handler);

    dispose();

    expect(client.removeRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.removeRequestHandler).toHaveBeenCalledWith('elicitation/create');
  });

  it("never removes a newer call's handler, and disposal is idempotent", () => {
    const { client, connection } = makeFakeConnection();
    const disposeFirst = MCPConnection.prototype.setElicitationHandler.call(connection, handler);
    const disposeSecond = MCPConnection.prototype.setElicitationHandler.call(connection, handler);

    disposeFirst();
    expect(client.removeRequestHandler).not.toHaveBeenCalled();

    disposeSecond();
    disposeSecond();
    expect(client.removeRequestHandler).toHaveBeenCalledTimes(1);
  });
});

describe('extractUrlElicitation', () => {
  const elicitation = {
    mode: 'url',
    message: 'Please authorize access to github',
    url: 'https://bedrock-agentcore.eu-west-1.amazonaws.com/identities/oauth2/authorize?request_uri=abc',
    elicitationId: '8cd9f2ba-103d-44c9-8471-6dd02df67c1b',
  };

  it('extracts from a protocol-level McpError shape (code -32042 + data)', () => {
    const error = { code: -32042, data: { elicitations: [elicitation] } };
    expect(extractUrlElicitation(error)).toEqual(elicitation);
  });

  it('extracts from a gateway HTTP-wrapped transport error (the AgentCore wire shape)', () => {
    // Exact shape observed live: gateway returns JSON-RPC errors with a non-2xx
    // HTTP status, so the SDK throws a StreamableHTTPError whose message embeds
    // the raw body and whose `code` is the HTTP status, not -32042.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      error: {
        code: -32042,
        message: 'This request requires authorization.',
        data: { elicitations: [elicitation] },
      },
    });
    const error = Object.assign(
      new Error(`Streamable HTTP error: Error POSTing to endpoint: ${body}`),
      {
        code: 401,
      },
    );
    expect(extractUrlElicitation(error)).toEqual(elicitation);
  });

  it('extracts a whitespaced HTTP-wrapped body (pretty-printed / key-reordered gateway JSON)', () => {
    // A gateway that pretty-prints yields `"code": -32042` (note the space) and
    // may order keys differently; a literal `"code":-32042` substring match would
    // miss it, so extraction must tolerate JSON formatting variance.
    const body = JSON.stringify(
      {
        jsonrpc: '2.0',
        id: 9,
        error: {
          message: 'This request requires authorization.',
          data: { elicitations: [elicitation] },
          code: -32042,
        },
      },
      null,
      2,
    );
    const error = Object.assign(
      new Error(`Streamable HTTP error: Error POSTing to endpoint: ${body}`),
      { code: 401 },
    );
    expect(extractUrlElicitation(error)).toEqual(elicitation);
  });

  it('returns null for non-elicitation errors in both shapes', () => {
    expect(extractUrlElicitation(new Error('boom'))).toBeNull();
    expect(extractUrlElicitation({ code: -32600, data: {} })).toBeNull();
    expect(
      extractUrlElicitation(
        new Error(
          'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"Session not initialized"}}',
        ),
      ),
    ).toBeNull();
    expect(extractUrlElicitation(null)).toBeNull();
  });

  it('returns null for a -32042 mention with an unparseable body', () => {
    expect(
      extractUrlElicitation(new Error('Error POSTing to endpoint: {"code":-32042, truncated')),
    ).toBeNull();
  });
});
