import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSelectProps } from '~/common';
import type { FC } from 'react';

import OpenAI from './OpenAI';
import BingAI from './BingAI';
import Google from './Google';
import ChatGPT from './ChatGPT';
import Anthropic from './Anthropic';
import PluginsByIndex from './PluginsByIndex';
import BedrockAgent from './BedrockAgent';

export const options: { [key: string]: FC<TModelSelectProps> } = {
  [EModelEndpoint.openAI]: OpenAI,
  [EModelEndpoint.custom]: OpenAI,
  [EModelEndpoint.bedrock]: OpenAI,
  [EModelEndpoint.bedrockAgent]: BedrockAgent,
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
