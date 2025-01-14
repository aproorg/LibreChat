import { useQuery } from '@tanstack/react-query';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';
import { QueryKeys } from '../keys';
import request from '../request';
import { TBedrockAgent } from '../types/bedrockAgent';

interface BedrockAgentListResponse {
  agents: TBedrockAgent[];
}

const fetchBedrockAgents = async (): Promise<BedrockAgentListResponse> => {
  try {
    console.debug('[BedrockAgent] Fetching agents...');
    const response = await request.get<BedrockAgentListResponse>('/api/bedrock-agent/list');
    console.debug('[BedrockAgent] Agents fetched:', response);
    return response;
  } catch (error: any) {
    console.error('[BedrockAgent] Error fetching agents:', {
      error,
      message: error.message,
      status: error.status,
      response: error.response
    });
    throw error;
  }
};

export const useListBedrockAgentsQuery = (
  config?: UseQueryOptions<BedrockAgentListResponse>,
): QueryObserverResult<BedrockAgentListResponse> => {
  return useQuery<BedrockAgentListResponse>([QueryKeys.bedrockAgents], fetchBedrockAgents, {
    refetchOnWindowFocus: false,
    ...config,
  });
};
