import { z } from 'zod';
import { agentsSettings } from '../agent-settings';
import { baseEndpointSchema } from '../settings';
import { removeNullishValues } from '../schemas';
import type { TConversation } from '../types';

export const bedrockAgentEndpointSchema = z.object({
  name: z.string(),
  region: z.string(),
  models: z.object({
    default: z.array(z.string()),
    supported: z.array(z.string()).optional(),
  }),
  iconURL: z.string().optional(),
  modelDisplayLabel: z.string().optional(),
  agentId: z.string().optional(),
  agentAliasId: z.string().optional(),
  knowledgeBaseId: z.string().optional(),
  temperature: z.number().optional(),
  topK: z.number().optional(),
  topP: z.number().optional(),
});

export const bedrockAgentSchema = z
  .object({
    model: z.string(),
    modelLabel: z.string().nullable(),
    agentId: z.string().optional(),
    agentAliasId: z.string().optional(),
    region: z.string(),
    knowledgeBaseId: z.string().optional(),
    temperature: z.number().optional(),
    topK: z.number().optional(),
    topP: z.number().optional(),
    promptPrefix: z.string().nullable(),
    iconURL: z.string().nullable(),
    greeting: z.string().optional(),
  })
  .transform((obj) => ({
    ...obj,
    model: obj.model ?? 'bedrock-agent',
    modelLabel: obj.modelLabel ?? null,
    temperature: obj.temperature ?? agentsSettings.temperature.default,
    topK: obj.topK ?? 5,
    topP: obj.topP ?? 0.9,
    promptPrefix: obj.promptPrefix ?? null,
    iconURL: obj.iconURL ?? undefined,
    greeting: obj.greeting ?? undefined,
  }))
  .catch(() => ({
    model: 'bedrock-agent',
    modelLabel: null,
    agentId: '',
    agentAliasId: '',
    region: 'eu-central-1',
    temperature: agentsSettings.temperature.default,
    topK: 5,
    topP: 0.9,
    promptPrefix: null,
    iconURL: undefined,
    greeting: undefined,
  }));

export const compactBedrockAgentSchema = z
  .object({
    model: z.string(),
    modelLabel: z.string().nullable(),
    agentId: z.string().optional(),
    agentAliasId: z.string().optional(),
    region: z.string(),
    knowledgeBaseId: z.string().optional(),
    temperature: z.number().optional(),
    topK: z.number().optional(),
    topP: z.number().optional(),
    promptPrefix: z.string().nullable(),
    iconURL: z.string().nullable(),
    greeting: z.string().optional(),
  })
  .transform((obj: Partial<TConversation>) => {
    const newObj = { ...obj };
    if (newObj.temperature === agentsSettings.temperature.default) {
      delete newObj.temperature;
    }
    if (newObj.topK === 5) {
      delete newObj.topK;
    }
    if (newObj.topP === 0.9) {
      delete newObj.topP;
    }
    return removeNullishValues(newObj);
  })
  .catch(() => ({
    model: 'bedrock-agent',
    modelLabel: null,
    agentId: '',
    agentAliasId: '',
    region: 'eu-central-1',
    temperature: agentsSettings.temperature.default,
    topK: 5,
    topP: 0.9,
    promptPrefix: null,
    iconURL: undefined,
    greeting: undefined,
  }));
