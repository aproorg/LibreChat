import { z } from 'zod';

export const baseEndpointSchema = z.object({
  streamRate: z.number().optional(),
  baseURL: z.string().optional(),
  titlePrompt: z.string().optional(),
  titleModel: z.string().optional(),
});
