export interface TBedrockAgent {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  region?: string;
}

export interface TBedrockAgentSession {
  sessionId: string;
  agentId: string;
  agentAliasId?: string;
  createdAt: string;
  lastActivity: string;
  metadata?: Record<string, unknown>;
}
