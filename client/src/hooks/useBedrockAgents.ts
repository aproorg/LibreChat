import { useQuery } from '@tanstack/react-query';
import type { TBedrockAgent } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';

export const useBedrockAgents = () => {
  const { token } = useAuthContext();

  return useQuery<TBedrockAgent[]>({
    queryKey: ['bedrockAgents'],
    queryFn: async () => {
      try {
        const response = await fetch('/api/bedrock/agents', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!response.ok) {
          throw new Error('Failed to fetch Bedrock agents');
        }
        return response.json();
      } catch (error) {
        console.error('Error fetching Bedrock agents:', error);
        return [];
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnWindowFocus: false,
  });
};

export default useBedrockAgents;
