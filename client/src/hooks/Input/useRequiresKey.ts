import { useGetEndpointsQuery } from 'librechat-data-provider/react-query';
import { useChatContext } from '~/Providers/ChatContext';
import { getEndpointField } from '~/utils';
import useUserKey from './useUserKey';

export default function useRequiresKey() {
  const { conversation } = useChatContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { endpoint } = conversation || {};
  const userProvidesKey: boolean | null | undefined = getEndpointField(
    endpointsConfig,
    endpoint,
    'userProvide',
  );
  const { getExpiry } = useUserKey(endpoint ?? '');
  const expiryTime = getExpiry();
  // Special case for bedrockAgents endpoint - don't require key
  const requiresKey = endpoint === 'bedrockAgents' ? false : (!expiryTime && userProvidesKey);
  console.log('useRequiresKey:', { endpoint, userProvidesKey, expiryTime, requiresKey });
  return { requiresKey };
}
