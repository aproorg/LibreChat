import { useMemo } from 'react';
import { EModelEndpoint, AgentCapabilities } from 'librechat-data-provider';
import type { TAgentsEndpoint, TEndpointsConfig, TConfig } from 'librechat-data-provider';
import { useGetEndpointsQuery } from '~/data-provider';

type ClientAgentsEndpoint = TAgentsEndpoint & Pick<TConfig, 'codeDefaultProfile'>;

interface UseGetAgentsConfigOptions {
  endpointsConfig?: TEndpointsConfig;
}

export default function useGetAgentsConfig(options?: UseGetAgentsConfigOptions): {
  agentsConfig?: ClientAgentsEndpoint | null;
  endpointsConfig?: TEndpointsConfig | null;
} {
  const { endpointsConfig: providedConfig } = options || {};

  const { data: queriedConfig } = useGetEndpointsQuery({
    enabled: !providedConfig,
  });

  const endpointsConfig = providedConfig || queriedConfig;

  const agentsConfig = useMemo<ClientAgentsEndpoint | null>(() => {
    const config: ClientAgentsEndpoint | null =
      (endpointsConfig?.[EModelEndpoint.agents] as ClientAgentsEndpoint | null) ?? null;
    if (!config) return null;

    return {
      ...config,
      capabilities: Array.isArray(config.capabilities)
        ? config.capabilities.map((cap) => cap as unknown as AgentCapabilities)
        : ([] as AgentCapabilities[]),
    } as ClientAgentsEndpoint;
  }, [endpointsConfig]);

  return { agentsConfig, endpointsConfig };
}
