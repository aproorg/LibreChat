import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSelectProps } from '~/common';
import type { FC } from 'react';

import OpenAI from './OpenAI';
import BingAI from './BingAI';
import Google from './Google';
import ChatGPT from './ChatGPT';
import Anthropic from './Anthropic';
import BedrockAgents from './BedrockAgents';
import PluginsByIndex from './PluginsByIndex';

export const options: { [key: string]: FC<TModelSelectProps> } = {
  [EModelEndpoint.openAI]: OpenAI,
  [EModelEndpoint.custom]: OpenAI,
  [EModelEndpoint.bedrock]: OpenAI,
  [EModelEndpoint.bedrockAgents]: BedrockAgents as FC<TModelSelectProps>,
  'agents': BedrockAgents as FC<TModelSelectProps>,  // Add support for 'agents' endpoint
  [EModelEndpoint.azureOpenAI]: OpenAI,
  [EModelEndpoint.bingAI]: BingAI,
  [EModelEndpoint.google]: Google,
  [EModelEndpoint.anthropic]: Anthropic,
  [EModelEndpoint.chatGPTBrowser]: ChatGPT,
};

export const multiChatOptions = {
  ...options,
  [EModelEndpoint.gptPlugins]: PluginsByIndex,
};
