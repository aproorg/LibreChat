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
  const response = await request.get<BedrockAgentListResponse>('/api/bedrock-agent/list');
  return response.data;
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
