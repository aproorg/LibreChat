import type { z } from 'zod';
import type { configSchema } from '../config';

export type TBedrockAgent = {
  agentId: string;
  agentName: string;
  agentAliasId?: string;
  description?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
};

export type TBedrockConfig = z.infer<typeof configSchema> & {
  agentId?: string;
  agentAliasId?: string;
  region?: string;
};
