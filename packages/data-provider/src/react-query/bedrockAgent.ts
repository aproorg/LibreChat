import { useQuery } from '@tanstack/react-query';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';
import type { TBedrockAgent } from '../types/bedrockAgent';
import { QueryKeys } from '../keys';
import request from '../request';

export interface BedrockAgentListResponse {
  agents: Array<{
    id: string;
    name: string;
    description: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

async function fetchBedrockAgents(): Promise<BedrockAgentListResponse> {
  try {
    const response = await request.get<BedrockAgentListResponse>('/api/bedrock-agent/list');
    // Ensure we have a valid response with agents array
    if (response?.data?.agents) {
      return response.data;
    }
    // Return empty agents array if response is invalid
    return { agents: [] };
  } catch (error) {
    console.error('[BedrockAgent] Error fetching agents:', error);
    return { agents: [] };
  }
}

export function useListBedrockAgentsQuery(
  config?: UseQueryOptions<BedrockAgentListResponse>,
): QueryObserverResult<BedrockAgentListResponse> {
  return useQuery<BedrockAgentListResponse>(
    [QueryKeys.bedrockAgents],
    fetchBedrockAgents,
    {
      refetchOnWindowFocus: false,
      ...config,
    },
  );
}
