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
  const servers = new Set<string>();
  for (const tool of agent.tools ?? []) {
    const server = typeof tool === 'string' ? splitMCPToolKey(tool)[1] : undefined;
    if (server) {
      servers.add(server);
    }
  }
  return (
    access.check({ endpoint: 'agents', mcpServers: [...servers] }) ??
    access.check({ endpoint: agent.provider })
  );
}
