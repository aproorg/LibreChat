import { z } from 'zod';

export const baseEndpointSchema = z.object({
  streamRate: z.number().optional(),
  baseURL: z.string().optional(),
  titlePrompt: z.string().optional(),
  titleModel: z.string().optional(),
  models: z.object({
    default: z.array(z.string()),
    supported: z.array(z.string()).optional(),
  }).optional(),
  name: z.string().optional(),
  iconURL: z.string().optional(),
  modelDisplayLabel: z.string().optional(),
});
