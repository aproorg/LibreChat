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
    const response = await request.get<BedrockAgentListResponse>('/api/bedrock-agent/list');
    return response;
  } catch (error) {
    console.error('[BedrockAgent] Error fetching agents:', error);
    return { agents: [] };
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
