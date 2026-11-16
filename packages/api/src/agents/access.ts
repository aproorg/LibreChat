import { splitMCPToolKey } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { Access, AccessRefusal } from '~/access';
import { AccessRefusedError } from '~/access';

/** An access refusal that request boundaries answer with HTTP 403. */
export class AgentAccessRefusedError extends AccessRefusedError {
  readonly status = 403;
}

/**
 * Refuses an agent whose `agents` endpoint, provider endpoint, or any attached
 * MCP server is limited to people the caller is not. Null when `access` is null.
 */
export function checkAgentAccess(
  agent: Pick<Agent, 'provider' | 'tools'>,
  access: Access | null | undefined,
): AccessRefusal | null {
  if (!access) {
    return null;
  }
  const tool = (agent.tools ?? []).find(
    (key) => typeof key === 'string' && !access.allowsMcpTool(key),
  );
  if (typeof tool === 'string') {
    return { kind: 'mcpServer', name: splitMCPToolKey(tool)[1] ?? tool };
  }
  return access.check({ endpoint: 'agents' }) ?? access.check({ endpoint: agent.provider });
}

/** Throws {@link AgentAccessRefusedError} (fatal at initialization) when {@link checkAgentAccess} refuses. */
export function assertAgentAccess(
  agent: Pick<Agent, 'provider' | 'tools'>,
  access: Access | null | undefined,
): void {
  const refusal = checkAgentAccess(agent, access);
  if (refusal) {
    throw new AgentAccessRefusedError(refusal);
  }
}
