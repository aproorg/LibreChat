import { logger } from '@librechat/data-schemas';
import {
  AuthType,
  EModelEndpoint,
  isAgentsEndpoint,
  orderEndpointsConfig,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type {
  AgentCapabilities,
  TEndpointsConfig,
  TConfig,
  TModelsConfig,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest, TCustomEndpointsConfig } from '~/types';
import { loadCustomEndpointsConfig as defaultLoadCustomEndpoints } from '~/endpoints/custom';

type PartialEndpointEntry = Partial<TConfig> & Record<string, unknown>;
type DefaultEndpointsResult = Record<string, PartialEndpointEntry | false | null>;
type MutableEndpointsConfig = Record<string, PartialEndpointEntry | false | null | undefined>;

export interface EndpointsConfigDeps {
  getAppConfig: (params: {
    role?: string;
    userId?: string;
    tenantId?: string;
  }) => Promise<AppConfig>;
  loadDefaultEndpointsConfig: (appConfig: AppConfig) => Promise<DefaultEndpointsResult>;
  loadCustomEndpointsConfig?: (custom: unknown) => TCustomEndpointsConfig | undefined;
  /**
   * Resolves the models available to this request. Supplied so a custom
   * endpoint with nothing to serve can be withheld from the endpoints config
   * entirely; omit it to leave every declared endpoint in place.
   */
  getModelsConfig?: (req: ServerRequest) => Promise<TModelsConfig>;
}

export interface GetEndpointsConfigOptions {
  /**
   * Drop custom endpoints that can serve nothing for this request.
   *
   * Off by default, and deliberately: it costs a models resolution, which for a
   * user-scoped endpoint means a live catalog fetch, and it removes keys that
   * callers on the request path read for reasons unrelated to presentation —
   * `defaultParamsEndpoint`, `userProvide`. Only a caller answering "what may
   * this user be offered" wants it.
   */
  withholdEmpty?: boolean;
}

export function createEndpointsConfigService(deps: EndpointsConfigDeps): {
  getEndpointsConfig: (
    req: ServerRequest,
    options?: GetEndpointsConfigOptions,
  ) => Promise<TEndpointsConfig>;
  checkCapability: (req: ServerRequest, capability: AgentCapabilities) => Promise<boolean>;
} {
  const {
    getAppConfig,
    loadDefaultEndpointsConfig,
    loadCustomEndpointsConfig = defaultLoadCustomEndpoints,
    getModelsConfig,
  } = deps;

  async function getEndpointsConfig(
    req: ServerRequest,
    options: GetEndpointsConfigOptions = {},
  ): Promise<TEndpointsConfig> {
    const appConfig =
      req.config ??
      (await getAppConfig({
        role: req.user?.role,
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
      }));
    const defaultEndpointsConfig = await loadDefaultEndpointsConfig(appConfig);
    const customEndpointsConfig = loadCustomEndpointsConfig(appConfig?.endpoints?.custom);

    const mergedConfig: MutableEndpointsConfig = {
      ...defaultEndpointsConfig,
      ...customEndpointsConfig,
    };

    if (appConfig.endpoints?.[EModelEndpoint.azureOpenAI]) {
      mergedConfig[EModelEndpoint.azureOpenAI] = { userProvide: false };
    }

    if (appConfig.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig?.enabled) {
      mergedConfig[EModelEndpoint.anthropic] = { userProvide: false };
    }

    if (appConfig.endpoints?.[EModelEndpoint.azureOpenAI]?.assistants) {
      mergedConfig[EModelEndpoint.azureAssistants] = { userProvide: false };
    }

    if (
      mergedConfig[EModelEndpoint.assistants] &&
      appConfig?.endpoints?.[EModelEndpoint.assistants]
    ) {
      const { disableBuilder, retrievalModels, capabilities, version } =
        appConfig.endpoints[EModelEndpoint.assistants];
      mergedConfig[EModelEndpoint.assistants] = {
        ...mergedConfig[EModelEndpoint.assistants],
        version: version != null ? String(version) : undefined,
        retrievalModels,
        disableBuilder,
        capabilities,
      };
    }

    if (mergedConfig[EModelEndpoint.agents] && appConfig?.endpoints?.[EModelEndpoint.agents]) {
      const { disableBuilder, capabilities, allowedProviders } =
        appConfig.endpoints[EModelEndpoint.agents];
      mergedConfig[EModelEndpoint.agents] = {
        ...mergedConfig[EModelEndpoint.agents],
        allowedProviders,
        disableBuilder,
        capabilities,
      };
    }

    if (
      mergedConfig[EModelEndpoint.azureAssistants] &&
      appConfig?.endpoints?.[EModelEndpoint.azureAssistants]
    ) {
      const { disableBuilder, retrievalModels, capabilities, version } =
        appConfig.endpoints[EModelEndpoint.azureAssistants];
      mergedConfig[EModelEndpoint.azureAssistants] = {
        ...mergedConfig[EModelEndpoint.azureAssistants],
        version: version != null ? String(version) : undefined,
        retrievalModels,
        disableBuilder,
        capabilities,
      };
    }

    if (mergedConfig[EModelEndpoint.bedrock] && appConfig?.endpoints?.[EModelEndpoint.bedrock]) {
      const { availableRegions } = appConfig.endpoints[EModelEndpoint.bedrock] as {
        availableRegions?: string[];
      };
      mergedConfig[EModelEndpoint.bedrock] = {
        ...mergedConfig[EModelEndpoint.bedrock],
        availableRegions,
      };
    }

    if (mergedConfig[EModelEndpoint.bedrock]) {
      mergedConfig[EModelEndpoint.bedrock] = {
        ...mergedConfig[EModelEndpoint.bedrock],
        userProvideAccessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID === AuthType.USER_PROVIDED,
        userProvideSecretAccessKey:
          process.env.BEDROCK_AWS_SECRET_ACCESS_KEY === AuthType.USER_PROVIDED,
        userProvideSessionToken: process.env.BEDROCK_AWS_SESSION_TOKEN === AuthType.USER_PROVIDED,
        userProvideBearerToken: process.env.BEDROCK_AWS_BEARER_TOKEN === AuthType.USER_PROVIDED,
      };
    }

    if (options.withholdEmpty) {
      await withholdEmptyCustomEndpoints(req, mergedConfig, customEndpointsConfig);
    }

    return orderEndpointsConfig(mergedConfig as TEndpointsConfig);
  }

  /**
   * Removes custom endpoints that can serve nothing for this request.
   *
   * An endpoint with an empty model list is not a usable endpoint: it renders
   * as an empty picker entry, and the agent builder offers it as a provider
   * with no model to pick. Built-in endpoints are left alone — their model
   * lists come from elsewhere and are not per-request.
   *
   * Fails open. Only an explicit empty list withholds an endpoint; a models
   * loader that throws, or that has no entry for an endpoint at all, leaves
   * every declared endpoint in place.
   *
   * Reached only when the caller asks for it — see `withholdEmpty`.
   */
  async function withholdEmptyCustomEndpoints(
    req: ServerRequest,
    mergedConfig: MutableEndpointsConfig,
    customEndpointsConfig: TCustomEndpointsConfig | undefined,
  ): Promise<void> {
    if (getModelsConfig == null || customEndpointsConfig == null) {
      return;
    }

    const customNames = Object.keys(customEndpointsConfig);
    if (customNames.length === 0) {
      return;
    }

    let modelsConfig: TModelsConfig;
    try {
      modelsConfig = await getModelsConfig(req);
    } catch (error) {
      logger.error(
        '[getEndpointsConfig] Could not resolve available models; leaving every declared endpoint in place',
        error,
      );
      return;
    }

    for (const name of customNames) {
      const available = modelsConfig?.[name];
      if (Array.isArray(available) && available.length === 0) {
        logger.debug(
          `[getEndpointsConfig] Withholding custom endpoint "${name}": no models available for this request`,
        );
        delete mergedConfig[name];
      }
    }
  }

  async function checkCapability(
    req: ServerRequest,
    capability: AgentCapabilities,
  ): Promise<boolean> {
    const isAgents = isAgentsEndpoint(req.body?.endpointType || req.body?.endpoint);
    const endpointsConfig = await getEndpointsConfig(req);
    const capabilities =
      isAgents || endpointsConfig?.[EModelEndpoint.agents]?.capabilities != null
        ? (endpointsConfig?.[EModelEndpoint.agents]?.capabilities ?? [])
        : defaultAgentCapabilities;
    return capabilities.includes(capability);
  }

  return { getEndpointsConfig, checkCapability };
}
