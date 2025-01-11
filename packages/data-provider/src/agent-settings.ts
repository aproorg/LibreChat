import { imageDetailSettings } from './image-detail';

export const agentsSettings = {
  model: {
    default: 'gpt-3.5-turbo-test',
  },
  temperature: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
  },
  top_p: {
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
  },
  presence_penalty: {
    min: 0,
    max: 2,
    step: 0.01,
    default: 0,
  },
  frequency_penalty: {
    min: 0,
    max: 2,
    step: 0.01,
    default: 0,
  },
  resendFiles: {
    default: true,
  },
  maxContextTokens: {
    default: undefined,
  },
  max_tokens: {
    default: undefined,
  },
  imageDetail: imageDetailSettings,
} as const;
