import { randomUUID } from 'crypto';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/** A single URL-mode elicitation as carried by a -32042 `UrlElicitationRequired`
 *  error's `data.elicitations` (MCP spec 2025-11-25). */
export interface UrlElicitation {
  mode?: string;
  message: string;
  url: string;
  elicitationId: string;
}

/**
 * Extracts the first URL elicitation from a failed `tools/call`, handling both
 * wire shapes a -32042 can arrive in:
 *
 * 1. A protocol-level JSON-RPC error response — the SDK surfaces it as an
 *    `McpError`/`UrlElicitationRequiredError` with `code === -32042` and
 *    `data.elicitations`.
 * 2. An HTTP-level rejection — AgentCore Gateway returns JSON-RPC errors with a
 *    non-2xx status, so the SDK's streamable-HTTP transport never parses the
 *    body and instead throws a `StreamableHTTPError` whose `code` is the HTTP
 *    status and whose message embeds the raw body
 *    (`"Error POSTing to endpoint: {\"jsonrpc\":...,\"error\":{\"code\":-32042,...}}"`).
 *
 * Returns `null` when the error is not a URL elicitation in either shape.
 */
export function extractUrlElicitation(error: unknown): UrlElicitation | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const { code, data, message } = error as {
    code?: unknown;
    data?: { elicitations?: UrlElicitation[] };
    message?: unknown;
  };

  if (code === ErrorCode.UrlElicitationRequired) {
    return data?.elicitations?.[0] ?? null;
  }

  // Cheap pre-filter on the bare error number (not `"code":-32042`) so gateway
  // JSON with whitespace/key-order variance — e.g. a pretty-printed
  // `"code": -32042` — still gets parsed; the JSON.parse + numeric-code check
  // below is what actually validates the shape.
  if (typeof message !== 'string' || !message.includes(String(ErrorCode.UrlElicitationRequired))) {
    return null;
  }
  const braceIndex = message.indexOf('{');
  if (braceIndex === -1) {
    return null;
  }
  const body = message.slice(braceIndex);
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: number; data?: { elicitations?: UrlElicitation[] } };
    };
    if (parsed.error?.code !== ErrorCode.UrlElicitationRequired) {
      return null;
    }
    return parsed.error.data?.elicitations?.[0] ?? null;
  } catch {
    return null;
  }
}
import type { FlowStateManager } from '~/flow/manager';

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
 * Re-views the process-wide {@link FlowStateManager} singleton — statically typed for OAuth
 * tokens at its main call sites — as an elicitation-flow manager. The manager stores payloads
 * keyed at runtime by (flowId, flow type); the payload shape for an `mcp_elicit` flow is
 * fixed by the flow type, not the class generic, so the generic is erased here. This is the
 * one audited place that assertion lives, so callers never scatter `as unknown as`.
 */
export function asElicitationFlowManager(
  flowManager: unknown,
): FlowStateManager<ElicitationFlowResult> {
  return flowManager as FlowStateManager<ElicitationFlowResult>;
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
 *
 * Every variable segment is URI-encoded so a `:` inside any of them (server and
 * tool names are config/user-derived) can't skew the fields {@link
 * parseElicitationFlowId} reads back out.
 */
export function generateElicitationFlowId(
  userId: string,
  serverName: string,
  toolName: string,
  tenantId?: string,
): string {
  const flowId = `${encodeURIComponent(userId)}:${encodeURIComponent(serverName)}:${encodeURIComponent(toolName)}:${randomUUID()}`;
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

  const [rawUserId, rawServerName, rawToolName, nonce] = parts.slice(offset, offset + 4);
  if (!rawUserId || !rawServerName || !rawToolName || !nonce) {
    return null;
  }

  try {
    return {
      userId: decodeURIComponent(rawUserId),
      serverName: decodeURIComponent(rawServerName),
      toolName: decodeURIComponent(rawToolName),
      nonce,
      tenantId,
    };
  } catch {
    return null;
  }
}
