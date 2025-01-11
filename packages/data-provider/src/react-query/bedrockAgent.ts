import { useQuery } from '@tanstack/react-query';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';
import type { TBedrockAgent } from '../types/bedrockAgent';
import { QueryKeys } from '../keys';
import request from '../request';

export interface BedrockAgentListResponse {
  agents: TBedrockAgent[];
}

async function fetchBedrockAgents(): Promise<TBedrockAgent[]> {
  const response = await request.get<BedrockAgentListResponse>('/api/bedrock-agent/list');
  return response.data.agents || [];
}

export function useListBedrockAgentsQuery(
  config?: UseQueryOptions<TBedrockAgent[]>,
): QueryObserverResult<TBedrockAgent[]> {
  return useQuery<TBedrockAgent[]>(
    [QueryKeys.bedrockAgents],
    fetchBedrockAgents,
    {
      refetchOnWindowFocus: false,
      ...config,
    },
  );
}
