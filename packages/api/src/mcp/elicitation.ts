import { randomUUID } from 'crypto';

/**
 * Terminal actions a client can post to `POST /api/mcp/elicitation/:flowId`.
 * `accept`/`decline`/`cancel` mirror the MCP SDK's `ElicitResultSchema.action`
 * (2025-06-18 form-mode elicitation). `complete` is the URL-exception (-32042)
 * "I've authorized — continue" signal that has no direct SDK analog, since that
 * path never sends an `elicitation/create` response — it just resumes a
 * suspended `tools/call`.
 */
export type ElicitationFlowAction = 'accept' | 'decline' | 'cancel' | 'complete';

export interface ElicitationFlowResult {
  action: ElicitationFlowAction;
  content?: Record<string, string | number | boolean>;
}

/**
 * True when a completed elicitation flow's action counts as "proceed" — either
 * the 2025-06-18 form-mode `accept`, or the URL-exception `complete`.
 */
export function isElicitationSuccess(action: ElicitationFlowAction | undefined): boolean {
  return action === 'accept' || action === 'complete';
}

/**
 * Maps a flow result's action onto the MCP SDK's `ElicitResultSchema.action`
 * enum (`accept` | `decline` | `cancel`), which has no `complete` member — the
 * URL-exception-only "I've authorized, continue" signal is treated as `accept`
 * for protocol responses.
 */
export function toElicitResultAction(
  action: ElicitationFlowAction,
): 'accept' | 'decline' | 'cancel' {
  if (action === 'complete') {
    return 'accept';
  }
  return action;
}

/**
 * Generates a flow ID for an MCP elicitation flow (a `mode: 'form'|'url'`
 * `elicitation/create` request, or a -32042 URL-exception retry).
 *
 * Unlike OAuth flow IDs (`MCPOAuthHandler.generateFlowId`, one per user+server),
 * elicitation flows are scoped per tool invocation — concurrent calls to the
 * same server must not collide — and the userId is embedded directly so the
 * completion route can enforce per-user ownership the same way OAuth flow
 * routes do (see `canAccessOAuthFlow` in `api/server/routes/mcp.js`).
 */
export function generateElicitationFlowId(
  userId: string,
  serverName: string,
  toolName: string,
  tenantId?: string,
): string {
  const flowId = `${userId}:${serverName}:${toolName}:${randomUUID()}`;
  if (!tenantId) {
    return flowId;
  }
  return `tenant:${encodeURIComponent(tenantId)}:${flowId}`;
}

export interface ParsedElicitationFlowId {
  userId: string;
  serverName: string;
  toolName: string;
  nonce: string;
  tenantId?: string;
}

/** Inverse of {@link generateElicitationFlowId}, used by the completion route to
 *  verify the requesting user owns the flow before resolving it. */
export function parseElicitationFlowId(flowId: string): ParsedElicitationFlowId | null {
  const parts = flowId.split(':');
  let offset = 0;
  let tenantId: string | undefined;

  if (parts[0] === 'tenant') {
    if (parts.length < 6 || !parts[1]) {
      return null;
    }
    try {
      tenantId = decodeURIComponent(parts[1]);
    } catch {
      return null;
    }
    offset = 2;
  }

  if (parts.length < offset + 4) {
    return null;
  }

  const [userId, serverName, toolName, nonce] = parts.slice(offset, offset + 4);
  if (!userId || !serverName || !toolName || !nonce) {
    return null;
  }

  return { userId, serverName, toolName, nonce, tenantId };
}
