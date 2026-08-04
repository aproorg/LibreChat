const { Router } = require('express');
const { logger, getTenantId, tenantStorage } = require('@librechat/data-schemas');
const {
  CacheKeys,
  Constants,
  PermissionBits,
  PermissionTypes,
  Permissions,
} = require('librechat-data-provider');
const {
  getBasePath,
  createSafeUser,
  MCPOAuthHandler,
  MCPTokenStorage,
  setOAuthSession,
  PENDING_STALE_MS,
  mcpConfig: mcpSettings,
  getUserMCPAuthMap,
  validateOAuthCsrf,
  OAUTH_CSRF_COOKIE,
  setOAuthCsrfCookie,
  generateCheckAccess,
  validateOAuthSession,
  OAUTH_SESSION_COOKIE,
  parseElicitationFlowId,
} = require('@librechat/api');
const {
  createMCPServerController,
  updateMCPServerController,
  deleteMCPServerController,
  getMCPServersList,
  getMCPServerById,
  getMCPTools,
} = require('~/server/controllers/mcp');
const {
  getOAuthReconnectionManager,
  getMCPServersRegistry,
  getFlowStateManager,
  getMCPManager,
} = require('~/config');
const {
  getServerConnectionStatus,
  resolveAllMcpConfigs,
  resolveConfigServers,
  getMCPSetupData,
  getElicitationFlowContext,
  resolveElicitationFlow,
} = require('~/server/services/MCP');
const { requireJwtAuth, canAccessMCPServerResource } = require('~/server/middleware');
const { getUserPluginAuthValue } = require('~/server/services/PluginService');
const { updateMCPServerTools } = require('~/server/services/Config/mcp');
const { reinitMCPServer } = require('~/server/services/Tools/mcp');
const { getLogStores } = require('~/cache');
const db = require('~/models');

const router = Router();

const OAUTH_CSRF_COOKIE_PATH = '/api/mcp';

const getOAuthFlowId = (userId, serverName) =>
  MCPOAuthHandler.generateFlowId(userId, serverName, getTenantId());

const canAccessOAuthFlow = (flowId, userId) => {
  const parsed = MCPOAuthHandler.parseFlowId(flowId);
  if (!parsed) {
    return false;
  }
  if (parsed.tenantId && parsed.tenantId !== getTenantId()) {
    return false;
  }
  return parsed.userId === userId || parsed.userId === 'system';
};

/**
 * Elicitation flow IDs embed the requesting userId directly (unlike OAuth flow
 * IDs, which are one-per-server; elicitation flows are one-per-tool-invocation
 * — see `generateElicitationFlowId` in `@librechat/api`). This enforces the
 * same per-user ownership OAuth flow routes do, so one user can't complete or
 * observe another user's pending elicitation via a guessed/observed flowId.
 */
const canAccessElicitationFlow = (flowId, userId) => {
  const parsed = parseElicitationFlowId(flowId);
  if (!parsed) {
    return false;
  }
  if (parsed.tenantId && parsed.tenantId !== getTenantId()) {
    return false;
  }
  return parsed.userId === userId;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates the restricted `format` keyword on a string property (spec
 * 2025-11-25: email, uri, date, date-time — the subset the client renders as a
 * specialized input). Returns an error message on violation, or `null`.
 * @param {string} key
 * @param {string} value
 * @param {string} format
 * @returns {string | null}
 */
const validateElicitationFormat = (key, value, format) => {
  if (format === 'email') {
    return EMAIL_PATTERN.test(value) ? null : `Field '${key}' must be a valid email address`;
  }
  if (format === 'uri') {
    try {
      new URL(value);
      return null;
    } catch {
      return `Field '${key}' must be a valid URI`;
    }
  }
  if (format === 'date' || format === 'date-time') {
    return Number.isNaN(Date.parse(value)) ? `Field '${key}' must be a valid ${format}` : null;
  }
  return null;
};

/**
 * Resolves the permitted member values for an array-type (multi-select)
 * property's `items` schema, supporting both shapes the client renders:
 * `items.enum` (bare values) and `items.anyOf: [{ const }]` (labeled options).
 * Returns `null` when `items` carries neither, i.e. any array is permitted.
 * @param {unknown} items
 * @returns {unknown[] | null}
 */
const getArrayItemMembers = (items) => {
  if (!items || typeof items !== 'object') {
    return null;
  }
  if (Array.isArray(items.enum)) {
    return items.enum;
  }
  if (Array.isArray(items.anyOf)) {
    return items.anyOf.map((option) => option?.const);
  }
  return null;
};

/**
 * Validates a single submitted elicitation field value against its property
 * schema (the MCP form-mode elicitation subset of JSON Schema). Returns an error
 * message on the first violation, or `null` when the value conforms.
 *
 * Beyond the base `Agents.ElicitationPropertySchema` type, this also validates
 * the extended subset the client renders: `pattern`, `format`, `oneOf`
 * (single-select from a labeled const list), and `array`/`items`/`minItems`/
 * `maxItems` (multi-select). `enumNames` is display-only labeling for `enum`
 * and is intentionally never validated.
 * @param {string} key
 * @param {unknown} value
 * @param {import('librechat-data-provider').Agents.ElicitationPropertySchema} property
 * @returns {string | null}
 */
const validateElicitationField = (key, value, property) => {
  const {
    type,
    enum: enumValues,
    minimum,
    maximum,
    minLength,
    maxLength,
    pattern,
    format,
    oneOf,
    items,
    minItems,
    maxItems,
  } = property ?? {};

  if (Array.isArray(oneOf) && oneOf.length > 0) {
    const allowedConsts = oneOf.map((option) => option?.const);
    if (!allowedConsts.includes(value)) {
      return `Field '${key}' must be one of the allowed options`;
    }
    return null;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      return `Field '${key}' must be an array`;
    }
    if (typeof minItems === 'number' && value.length < minItems) {
      return `Field '${key}' must have at least ${minItems} item(s)`;
    }
    if (typeof maxItems === 'number' && value.length > maxItems) {
      return `Field '${key}' must have at most ${maxItems} item(s)`;
    }
    const allowedMembers = getArrayItemMembers(items);
    if (allowedMembers && value.some((element) => !allowedMembers.includes(element))) {
      return `Field '${key}' contains an invalid selection`;
    }
    return null;
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      return `Field '${key}' must be a string`;
    }
    if (typeof minLength === 'number' && value.length < minLength) {
      return `Field '${key}' must be at least ${minLength} characters`;
    }
    if (typeof maxLength === 'number' && value.length > maxLength) {
      return `Field '${key}' must be at most ${maxLength} characters`;
    }
    if (typeof pattern === 'string') {
      let regex;
      try {
        regex = new RegExp(pattern);
      } catch {
        return `Field '${key}' has an invalid pattern`;
      }
      if (!regex.test(value)) {
        return `Field '${key}' does not match the required pattern`;
      }
    }
    if (typeof format === 'string') {
      const formatError = validateElicitationFormat(key, value, format);
      if (formatError) {
        return formatError;
      }
    }
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return `Field '${key}' must be a number`;
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      return `Field '${key}' must be an integer`;
    }
    if (typeof minimum === 'number' && value < minimum) {
      return `Field '${key}' must be >= ${minimum}`;
    }
    if (typeof maximum === 'number' && value > maximum) {
      return `Field '${key}' must be <= ${maximum}`;
    }
  } else if (type === 'boolean' && typeof value !== 'boolean') {
    return `Field '${key}' must be a boolean`;
  }

  if (Array.isArray(enumValues) && enumValues.length > 0 && !enumValues.includes(value)) {
    return `Field '${key}' must be one of: ${enumValues.join(', ')}`;
  }

  return null;
};

/**
 * Server-side guard for the elicitation completion route. The client validates
 * form submissions in the UI, but that check is trivially bypassed by calling
 * the API directly, so `content` is re-validated here against the flow's stored
 * `requestedSchema` before it is forwarded to the MCP server. Rejects unknown
 * keys and enforces per-field type/enum/range constraints; required-field
 * presence is only enforced for a submitting `accept` action (a `decline` /
 * `cancel` legitimately omits values). When the flow carries no schema (URL-mode
 * elicitation, or a schema not threaded into flow metadata) there is nothing to
 * validate against, so the content passes through unchanged.
 * @param {unknown} content
 * @param {import('librechat-data-provider').Agents.ElicitationSchema | undefined} requestedSchema
 * @param {{ enforceRequired: boolean }} options
 * @returns {string | null} An error message on violation, or `null` when valid.
 */
const validateElicitationContent = (content, requestedSchema, { enforceRequired }) => {
  if (!requestedSchema || typeof requestedSchema !== 'object') {
    return null;
  }

  if (content != null && (typeof content !== 'object' || Array.isArray(content))) {
    return 'content must be an object';
  }

  const properties = requestedSchema.properties ?? {};
  const values = content ?? {};

  for (const key of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      return `Unknown field: '${key}'`;
    }
  }

  if (enforceRequired && Array.isArray(requestedSchema.required)) {
    for (const key of requestedSchema.required) {
      if (values[key] === undefined || values[key] === null) {
        return `Missing required field: '${key}'`;
      }
    }
  }

  for (const [key, property] of Object.entries(properties)) {
    if (values[key] === undefined || values[key] === null) {
      continue;
    }
    const error = validateElicitationField(key, values[key], property);
    if (error) {
      return error;
    }
  }

  return null;
};

const clearGetTokensFlow = async ({ flowManager, flowId, tokens }) => {
  const state = await flowManager.getFlowState(flowId, 'mcp_get_tokens');
  if (state?.type === 'mcp_get_tokens' && state.status === 'PENDING') {
    await flowManager.completeFlow(flowId, 'mcp_get_tokens', tokens);
    return;
  }
  await flowManager.deleteFlow(flowId, 'mcp_get_tokens');
};

const checkMCPUsePermissions = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE],
  getRoleByName: db.getRoleByName,
});

const checkMCPCreate = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName: db.getRoleByName,
});

/**
 * Get all MCP tools available to the user
 * Returns only MCP tools, completely decoupled from regular LibreChat tools
 */
router.get('/tools', requireJwtAuth, checkMCPUsePermissions, async (req, res) => {
  return getMCPTools(req, res);
});

/**
 * Initiate OAuth flow
 * This endpoint is called when the user clicks the auth link in the UI
 */
router.get('/:serverName/oauth/initiate', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const { userId, flowId } = req.query;
    const user = req.user;

    // Verify the userId matches the authenticated user
    if (typeof userId !== 'string' || userId !== user.id) {
      return res.status(403).json({ error: 'User mismatch' });
    }

    const expectedFlowId = getOAuthFlowId(user.id, serverName);
    if (typeof flowId !== 'string' || flowId !== expectedFlowId) {
      logger.error('[MCP OAuth] Invalid flow ID for initiate request', {
        serverName,
        userId,
        flowId,
        expectedFlowId,
      });
      return res.status(403).json({ error: 'Flow mismatch' });
    }

    logger.debug('[MCP OAuth] Initiate request', { serverName, userId, flowId });

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    /** Flow state to retrieve OAuth config */
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      logger.error('[MCP OAuth] Flow state not found', { flowId });
      return res.status(404).json({ error: 'Flow not found' });
    }

    const {
      authorizationUrl: storedAuthorizationUrl,
      serverName: flowServerName,
      userId: flowUserId,
      serverUrl,
      oauth: oauthConfig,
    } = flowState.metadata || {};

    if (flowUserId && flowUserId !== user.id) {
      logger.error('[MCP OAuth] Flow user mismatch', { flowId, userId, flowUserId });
      return res.status(403).json({ error: 'User mismatch' });
    }

    if (flowServerName && flowServerName !== serverName) {
      logger.error('[MCP OAuth] Flow server mismatch', { flowId, serverName, flowServerName });
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    const pendingAge = flowState.createdAt ? Date.now() - flowState.createdAt : Infinity;
    const isFreshPendingFlow = flowState.status === 'PENDING' && pendingAge < PENDING_STALE_MS;
    if (!isFreshPendingFlow) {
      logger.error('[MCP OAuth] Flow is not active for initiation', {
        flowId,
        status: flowState.status,
        pendingAge,
      });
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    if (typeof storedAuthorizationUrl === 'string' && storedAuthorizationUrl.length > 0) {
      logger.debug('[MCP OAuth] Reusing stored authorization URL', {
        serverName,
        userId,
        flowId,
      });
      setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);
      return res.redirect(storedAuthorizationUrl);
    }

    if (!serverUrl || !oauthConfig) {
      logger.error('[MCP OAuth] Missing server URL or OAuth config in flow state');
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    const configServers = await resolveConfigServers(req);
    const oauthHeaders = await getOAuthHeaders(serverName, userId, configServers);
    const registry = getMCPServersRegistry();
    const { allowedDomains, allowedAddresses } = await registry.resolveAllowlists({
      userId,
      role: req.user?.role,
    });
    const {
      authorizationUrl,
      flowId: oauthFlowId,
      flowMetadata,
    } = await MCPOAuthHandler.initiateOAuthFlow(
      serverName,
      serverUrl,
      userId,
      oauthHeaders,
      oauthConfig,
      allowedDomains,
      undefined,
      allowedAddresses,
      getTenantId(),
    );

    logger.debug('[MCP OAuth] OAuth flow initiated', { oauthFlowId, authorizationUrl });

    const oldState = flowState.metadata?.state;
    if (typeof oldState === 'string') {
      await MCPOAuthHandler.deleteStateMapping(oldState, flowManager);
    }
    const metadataWithUrl = { ...flowMetadata, authorizationUrl, tenantId: getTenantId() };
    await flowManager.initFlow(oauthFlowId, 'mcp_oauth', metadataWithUrl);
    await MCPOAuthHandler.storeStateMapping(flowMetadata.state, oauthFlowId, flowManager);
    setOAuthCsrfCookie(res, oauthFlowId, OAUTH_CSRF_COOKIE_PATH);
    res.redirect(authorizationUrl);
  } catch (error) {
    logger.error('[MCP OAuth] Failed to initiate OAuth', error);
    res.status(500).json({ error: 'Failed to initiate OAuth' });
  }
});

/**
 * OAuth callback handler
 * This handles the OAuth callback after the user has authorized the application
 */
router.get('/:serverName/oauth/callback', async (req, res) => {
  const basePath = getBasePath();
  try {
    const { serverName } = req.params;
    const { code, state, error: oauthError } = req.query;

    logger.debug('[MCP OAuth] Callback received', {
      serverName,
      code: code ? 'present' : 'missing',
      state,
      error: oauthError,
    });

    if (oauthError) {
      logger.error('[MCP OAuth] OAuth error received', { error: oauthError });
      // Gate failFlow behind callback validation to prevent DoS via leaked state
      if (state && typeof state === 'string') {
        try {
          const flowsCache = getLogStores(CacheKeys.FLOWS);
          const flowManager = getFlowStateManager(flowsCache);
          const flowId = await MCPOAuthHandler.resolveStateToFlowId(state, flowManager);
          if (flowId) {
            const parsed = MCPOAuthHandler.parseFlowId(flowId);
            if (!parsed) {
              logger.warn('[MCP OAuth] Invalid flow ID format for OAuth error callback', {
                flowId,
              });
            } else {
              const hasCsrf = validateOAuthCsrf(req, res, flowId, OAUTH_CSRF_COOKIE_PATH);
              const hasSession = !hasCsrf && validateOAuthSession(req, parsed.userId);
              if (hasCsrf || hasSession) {
                await flowManager.failFlow(flowId, 'mcp_oauth', String(oauthError));
                logger.debug('[MCP OAuth] Marked flow as FAILED with OAuth error', {
                  flowId,
                  error: oauthError,
                });
              }
            }
          }
        } catch (err) {
          logger.debug('[MCP OAuth] Could not mark flow as failed', err);
        }
      }
      return res.redirect(
        `${basePath}/oauth/error?error=${encodeURIComponent(String(oauthError))}`,
      );
    }

    if (!code || typeof code !== 'string') {
      logger.error('[MCP OAuth] Missing or invalid code');
      return res.redirect(`${basePath}/oauth/error?error=missing_code`);
    }

    if (!state || typeof state !== 'string') {
      logger.error('[MCP OAuth] Missing or invalid state');
      return res.redirect(`${basePath}/oauth/error?error=missing_state`);
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowId = await MCPOAuthHandler.resolveStateToFlowId(state, flowManager);
    if (!flowId) {
      logger.error('[MCP OAuth] Could not resolve state to flow ID', { state });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }
    logger.debug('[MCP OAuth] Resolved flow ID from state', { flowId });

    const parsedFlowId = MCPOAuthHandler.parseFlowId(flowId);
    if (!parsedFlowId) {
      logger.error('[MCP OAuth] Invalid flow ID format', { flowId });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    const hasCsrf = validateOAuthCsrf(req, res, flowId, OAUTH_CSRF_COOKIE_PATH);
    const hasSession = !hasCsrf && validateOAuthSession(req, parsedFlowId.userId);
    let hasActiveFlow = false;
    if (!hasCsrf && !hasSession) {
      const pendingFlow = await flowManager.getFlowState(flowId, 'mcp_oauth');
      const pendingAge = pendingFlow?.createdAt ? Date.now() - pendingFlow.createdAt : Infinity;
      hasActiveFlow = pendingFlow?.status === 'PENDING' && pendingAge < PENDING_STALE_MS;
      if (hasActiveFlow) {
        logger.debug(
          '[MCP OAuth] CSRF/session cookies absent, validating via active PENDING flow',
          {
            flowId,
          },
        );
      }
    }

    if (!hasCsrf && !hasSession && !hasActiveFlow) {
      logger.error(
        '[MCP OAuth] CSRF validation failed: no valid CSRF cookie, session cookie, or active flow',
        {
          flowId,
          hasCsrfCookie: !!req.cookies?.[OAUTH_CSRF_COOKIE],
          hasSessionCookie: !!req.cookies?.[OAUTH_SESSION_COOKIE],
        },
      );
      return res.redirect(`${basePath}/oauth/error?error=csrf_validation_failed`);
    }

    logger.debug('[MCP OAuth] Getting flow state for flowId: ' + flowId);
    const flowState = await MCPOAuthHandler.getFlowState(flowId, flowManager);

    if (!flowState) {
      logger.error('[MCP OAuth] Flow state not found for flowId:', flowId);
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    logger.debug('[MCP OAuth] Flow state details', {
      serverName: flowState.serverName,
      userId: flowState.userId,
      hasMetadata: !!flowState.metadata,
      hasClientInfo: !!flowState.clientInfo,
      hasCodeVerifier: !!flowState.codeVerifier,
    });

    /** Check if this flow has already been completed (idempotency protection) */
    const currentFlowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (currentFlowState?.status === 'COMPLETED') {
      logger.warn('[MCP OAuth] Flow already completed, preventing duplicate token exchange', {
        flowId,
        serverName,
      });
      return res.redirect(`${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`);
    }

    logger.debug('[MCP OAuth] Completing OAuth flow');
    if (!flowState.oauthHeaders) {
      logger.warn(
        '[MCP OAuth] oauthHeaders absent from flow state — config-source server oauth_headers will be empty',
        { serverName, flowId },
      );
    }
    /**
     * Restore tenant context for the callback body. The callback is a cross-origin
     * redirect from the OAuth provider, so SameSite=Strict cookies (including the
     * JWT) are not sent. The tenantId was stored in the flow metadata at initiation
     * time when the user was authenticated.
     */
    const runWithTenant = async (fn) => {
      const flowTenantId = flowState.tenantId;
      if (flowTenantId && !getTenantId()) {
        return tenantStorage.run({ tenantId: flowTenantId }, fn);
      }
      return fn();
    };

    await runWithTenant(async () => {
      const oauthHeaders =
        flowState.oauthHeaders ?? (await getOAuthHeaders(serverName, flowState.userId));
      const tokens = await MCPOAuthHandler.completeOAuthFlow(
        flowId,
        code,
        flowManager,
        oauthHeaders,
      );
      logger.info('[MCP OAuth] OAuth flow completed, tokens received in callback route');

      /** Persist tokens immediately so reconnection uses fresh credentials */
      if (flowState?.userId && tokens) {
        try {
          await MCPTokenStorage.storeTokens({
            userId: flowState.userId,
            serverName,
            tokens,
            createToken: db.createToken,
            updateToken: db.updateToken,
            findToken: db.findToken,
            clientInfo: flowState.clientInfo,
            metadata: MCPOAuthHandler.buildStoredClientMetadata(
              flowState.metadata,
              flowState.resourceMetadata,
            ),
          });
          logger.debug('[MCP OAuth] Stored OAuth tokens prior to reconnection', {
            serverName,
            userId: flowState.userId,
          });
        } catch (error) {
          logger.error('[MCP OAuth] Failed to store OAuth tokens after callback', error);
          throw error;
        }

        /**
         * Clear any cached `mcp_get_tokens` flow result so subsequent lookups
         * re-fetch the freshly stored credentials instead of returning stale nulls.
         */
        if (typeof flowManager?.deleteFlow === 'function') {
          try {
            const tokenFlowId = MCPOAuthHandler.generateTokenFlowId(
              flowState.userId,
              serverName,
              flowState.tenantId,
            );
            await clearGetTokensFlow({
              flowManager,
              flowId: tokenFlowId,
              tokens,
            });
            if (tokenFlowId !== flowId) {
              await clearGetTokensFlow({
                flowManager,
                flowId,
                tokens,
              });
            }
          } catch (error) {
            logger.warn('[MCP OAuth] Failed to clear cached token flow state', error);
          }
        }
      }

      try {
        const mcpManager = getMCPManager(flowState.userId);
        logger.debug(`[MCP OAuth] Attempting to reconnect ${serverName} with new OAuth tokens`);

        if (flowState.userId !== 'system') {
          const user = { id: flowState.userId };

          /** Merged config (incl. Config-tier overlays) so the reconnection and
           *  the cache gate both see request-scoped servers the base registry
           *  lookup misses */
          let serverConfig;
          try {
            const allConfigs = await resolveAllMcpConfigs(flowState.userId);
            serverConfig = allConfigs?.[serverName];
          } catch (error) {
            logger.warn(
              `[MCP OAuth] Could not resolve server config for ${serverName} before reconnecting:`,
              error,
            );
          }

          const userConnection = await mcpManager.getUserConnection({
            user,
            serverName,
            flowManager,
            serverConfig,
            tokenMethods: {
              findToken: db.findToken,
              updateToken: db.updateToken,
              createToken: db.createToken,
              deleteTokens: db.deleteTokens,
            },
          });

          logger.info(
            `[MCP OAuth] Successfully reconnected ${serverName} for user ${flowState.userId}`,
          );

          const oauthReconnectionManager = getOAuthReconnectionManager();
          oauthReconnectionManager.clearReconnection(flowState.userId, serverName);

          const tools = await userConnection.fetchTools();
          await updateMCPServerTools({
            userId: flowState.userId,
            serverName,
            tools,
            serverConfig,
          });
        } else {
          logger.debug(`[MCP OAuth] System-level OAuth completed for ${serverName}`);
        }
      } catch (error) {
        logger.warn(
          `[MCP OAuth] Failed to reconnect ${serverName} after OAuth, but tokens are saved:`,
          error,
        );
      }

      /** ID of the flow that the tool/connection is waiting for */
      const toolFlowId = flowState.metadata?.toolFlowId;
      if (toolFlowId) {
        logger.debug('[MCP OAuth] Completing tool flow', { toolFlowId });
        const completed = await flowManager.completeFlow(toolFlowId, 'mcp_oauth', tokens);
        if (!completed) {
          logger.warn(
            '[MCP OAuth] Tool flow state not found during completion — waiter will time out',
            { toolFlowId },
          );
        }
      }
    }); /* end runWithTenant */

    /** Redirect to success page with flowId and serverName */
    const redirectUrl = `${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`;
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('[MCP OAuth] OAuth callback error', error);
    res.redirect(`${basePath}/oauth/error?error=callback_failed`);
  }
});

/**
 * Get OAuth tokens for a completed flow
 * This is primarily for user-level OAuth flows
 */
router.get('/oauth/tokens/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!canAccessOAuthFlow(flowId, user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    if (flowState.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Flow not completed' });
    }

    res.json({ tokens: flowState.result });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to get tokens', error);
    res.status(500).json({ error: 'Failed to get tokens' });
  }
});

/**
 * Set CSRF binding cookie for OAuth flows initiated outside of HTTP request/response
 * (e.g. during chat via SSE). The frontend should call this before opening the OAuth URL
 * so the callback can verify the browser matches the flow initiator.
 */
router.post('/:serverName/oauth/bind', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const flowId = getOAuthFlowId(user.id, serverName);
    setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);

    res.json({ success: true });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to set CSRF binding cookie', error);
    res.status(500).json({ error: 'Failed to bind OAuth flow' });
  }
});

/**
 * Check OAuth flow status
 * This endpoint can be used to poll the status of an OAuth flow
 */
router.get('/oauth/status/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!canAccessOAuthFlow(flowId, user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    res.json({
      status: flowState.status,
      completed: flowState.status === 'COMPLETED',
      failed: flowState.status === 'FAILED',
      error: flowState.error,
    });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to get flow status', error);
    res.status(500).json({ error: 'Failed to get flow status' });
  }
});

/**
 * Cancel OAuth flow
 * This endpoint cancels a pending OAuth flow
 */
router.post('/oauth/cancel/:serverName', requireJwtAuth, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    logger.info(`[MCP OAuth Cancel] Cancelling OAuth flow for ${serverName} by user ${user.id}`);

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);
    const flowId = getOAuthFlowId(user.id, serverName);
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');

    if (!flowState) {
      logger.debug(`[MCP OAuth Cancel] No active flow found for ${serverName}`);
      return res.json({
        success: true,
        message: 'No active OAuth flow to cancel',
      });
    }

    await flowManager.failFlow(flowId, 'mcp_oauth', 'User cancelled OAuth flow');

    logger.info(`[MCP OAuth Cancel] Successfully cancelled OAuth flow for ${serverName}`);

    res.json({
      success: true,
      message: `OAuth flow for ${serverName} cancelled successfully`,
    });
  } catch (error) {
    logger.error('[MCP OAuth Cancel] Failed to cancel OAuth flow', error);
    res.status(500).json({ error: 'Failed to cancel OAuth flow' });
  }
});

/**
 * Submit a response to an MCP elicitation request. Completes a pending
 * elicitation flow so `MCPManager.callTool` can resume:
 * - `action: 'accept' | 'decline' | 'cancel'` — form-mode `elicitation/create`
 *   response (spec 2025-06-18); `content` carries the submitted field values.
 * - `action: 'complete' | 'cancel'` — URL-mode card (either a `mode: 'url'`
 *   `elicitation/create` request, or a -32042 URL-exception retry): `complete`
 *   means "I've authorized — continue", which resumes/retries the tool call.
 */
router.post('/elicitation/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const { action, content } = req.body ?? {};
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!action || !['accept', 'decline', 'cancel', 'complete'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    if (!canAccessElicitationFlow(flowId, user.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_elicit');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    /**
     * Prefer the schema persisted in flow metadata (cross-process robust); fall
     * back to the in-process stream-context registry captured when the card was
     * emitted, so validation still works before that metadata is threaded.
     */
    const requestedSchema =
      flowState.metadata?.requestedSchema ?? getElicitationFlowContext(flowId)?.requestedSchema;
    const validationError = validateElicitationContent(content, requestedSchema, {
      enforceRequired: action === 'accept',
    });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Atomic PENDING->COMPLETED: exactly one concurrent submit wins even if both
    // requests read PENDING first.
    const won = await flowManager.completeFlowIfPending(flowId, 'mcp_elicit', { action, content });
    if (!won) {
      // Lost the race, already resolved, or gone entirely — tell the two apart so
      // a genuinely missing flow still reports 404 instead of 409.
      const settledState = await flowManager.getFlowState(flowId, 'mcp_elicit');
      if (!settledState) {
        return res.status(404).json({ error: 'Flow not found' });
      }
      return res.status(409).json({ error: 'Elicitation already resolved' });
    }

    /** Notify the originating stream so a resumed/replayed session renders the
     *  resolved card instead of a stale pending one. */
    await resolveElicitationFlow({
      flowId,
      action,
      content,
      fallbackStreamId: flowState.metadata?.streamId ?? null,
      fallbackStepId: flowState.metadata?.stepId,
    });

    return res.json({ ok: true });
  } catch (error) {
    logger.error('[MCP Elicitation] Failed to complete elicitation flow', error);
    return res.status(500).json({ error: 'Failed to complete elicitation flow' });
  }
});

/**
 * Reinitialize MCP server
 * This endpoint allows reinitializing a specific MCP server
 */
router.post(
  '/:serverName/reinitialize',
  requireJwtAuth,
  checkMCPUsePermissions,
  setOAuthSession,
  async (req, res) => {
    try {
      const { serverName } = req.params;
      const user = createSafeUser(req.user);

      if (!user.id) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      logger.info(`[MCP Reinitialize] Reinitializing server: ${serverName}`);

      const mcpManager = getMCPManager();
      const configServers = await resolveConfigServers(req);
      const serverConfig = await getMCPServersRegistry().getServerConfig(
        serverName,
        user.id,
        configServers,
      );
      if (!serverConfig) {
        return res.status(404).json({
          error: `MCP server '${serverName}' not found in configuration`,
        });
      }

      await mcpManager.disconnectUserConnection(user.id, serverName);
      logger.info(
        `[MCP Reinitialize] Disconnected existing user connection for server: ${serverName}`,
      );

      /** @type {Record<string, Record<string, string>> | undefined} */
      let userMCPAuthMap;
      if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
        userMCPAuthMap = await getUserMCPAuthMap({
          userId: user.id,
          servers: [serverName],
          findPluginAuthsByKeys: db.findPluginAuthsByKeys,
        });
      }

      const result = await reinitMCPServer({
        user,
        serverName,
        serverConfig,
        configServers,
        userMCPAuthMap,
      });

      if (!result) {
        return res.status(500).json({ error: 'Failed to reinitialize MCP server for user' });
      }

      const { success, message, oauthRequired, oauthUrl } = result;

      if (oauthRequired) {
        const flowId = getOAuthFlowId(user.id, serverName);
        setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);
      }

      res.json({
        success,
        message,
        oauthUrl,
        serverName,
        oauthRequired,
      });
    } catch (error) {
      logger.error('[MCP Reinitialize] Unexpected error', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/**
 * Get connection status for all MCP servers
 * This endpoint returns all app level and user-scoped connection statuses from MCPManager without disconnecting idle connections
 */
router.get('/connection/status', requireJwtAuth, async (req, res) => {
  try {
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(
      user.id,
      { role: user.role, tenantId: getTenantId() },
    );
    const connectionStatus = {};

    for (const [serverName, config] of Object.entries(mcpConfig)) {
      try {
        connectionStatus[serverName] = await getServerConnectionStatus(
          user.id,
          serverName,
          config,
          appConnections,
          userConnections,
          oauthServers,
        );
      } catch (error) {
        const message = `Failed to get status for server "${serverName}"`;
        logger.error(`[MCP Connection Status] ${message},`, error);
        connectionStatus[serverName] = {
          connectionState: 'error',
          requiresOAuth: oauthServers.has(serverName),
          error: message,
        };
      }
    }

    res.json({
      success: true,
      connectionStatus,
      oauthTimeout: mcpSettings.OAUTH_HANDLING_TIMEOUT,
    });
  } catch (error) {
    logger.error('[MCP Connection Status] Failed to get connection status', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

/**
 * Get connection status for a single MCP server
 * This endpoint returns the connection status for a specific server for a given user
 */
router.get('/connection/status/:serverName', requireJwtAuth, async (req, res) => {
  try {
    const user = req.user;
    const { serverName } = req.params;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(
      user.id,
      { role: user.role, tenantId: getTenantId() },
    );

    if (!mcpConfig[serverName]) {
      return res
        .status(404)
        .json({ error: `MCP server '${serverName}' not found in configuration` });
    }

    const serverStatus = await getServerConnectionStatus(
      user.id,
      serverName,
      mcpConfig[serverName],
      appConnections,
      userConnections,
      oauthServers,
    );

    res.json({
      success: true,
      serverName,
      connectionStatus: serverStatus.connectionState,
      requiresOAuth: serverStatus.requiresOAuth,
    });
  } catch (error) {
    logger.error(
      `[MCP Per-Server Status] Failed to get connection status for ${req.params.serverName}`,
      error,
    );
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

/**
 * Check which authentication values exist for a specific MCP server
 * This endpoint returns only boolean flags indicating if values are set, not the actual values
 */
router.get('/:serverName/auth-values', requireJwtAuth, checkMCPUsePermissions, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const configServers = await resolveConfigServers(req);
    const serverConfig = await getMCPServersRegistry().getServerConfig(
      serverName,
      user.id,
      configServers,
    );
    if (!serverConfig) {
      return res.status(404).json({
        error: `MCP server '${serverName}' not found in configuration`,
      });
    }

    const pluginKey = `${Constants.mcp_prefix}${serverName}`;
    const authValueFlags = {};

    if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
      for (const varName of Object.keys(serverConfig.customUserVars)) {
        try {
          const value = await getUserPluginAuthValue(user.id, varName, false, pluginKey);
          authValueFlags[varName] = !!(value && value.length > 0);
        } catch (err) {
          logger.error(
            `[MCP Auth Value Flags] Error checking ${varName} for user ${user.id}:`,
            err,
          );
          authValueFlags[varName] = false;
        }
      }
    }

    res.json({
      success: true,
      serverName,
      authValueFlags,
    });
  } catch (error) {
    logger.error(
      `[MCP Auth Value Flags] Failed to check auth value flags for ${req.params.serverName}`,
      error,
    );
    res.status(500).json({ error: 'Failed to check auth value flags' });
  }
});

async function getOAuthHeaders(serverName, userId, configServers) {
  const serverConfig = await getMCPServersRegistry().getServerConfig(
    serverName,
    userId,
    configServers,
  );
  return serverConfig?.oauth_headers ?? {};
}

/**
MCP Server CRUD Routes (User-Managed MCP Servers)
*/

/**
 * Get list of accessible MCP servers
 * @route GET /api/mcp/servers
 * @param {Object} req.query - Query parameters for pagination and search
 * @param {number} [req.query.limit] - Number of results per page
 * @param {string} [req.query.after] - Pagination cursor
 * @param {string} [req.query.search] - Search query for title/description
 * @returns {MCPServerListResponse} 200 - Success response - application/json
 */
router.get('/servers', requireJwtAuth, checkMCPUsePermissions, getMCPServersList);

/**
 * Create a new MCP server
 * @route POST /api/mcp/servers
 * @param {MCPServerCreateParams} req.body - The MCP server creation parameters.
 * @returns {MCPServer} 201 - Success response - application/json
 */
router.post('/servers', requireJwtAuth, checkMCPCreate, createMCPServerController);

/**
 * Get single MCP server by ID
 * @route GET /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @returns {MCPServer} 200 - Success response - application/json
 */
router.get(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPUsePermissions,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.VIEW,
    resourceIdParam: 'serverName',
  }),
  getMCPServerById,
);

/**
 * Update MCP server
 * @route PATCH /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @param {MCPServerUpdateParams} req.body - The MCP server update parameters.
 * @returns {MCPServer} 200 - Success response - application/json
 */
router.patch(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPCreate,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'serverName',
  }),
  updateMCPServerController,
);

/**
 * Delete MCP server
 * @route DELETE /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @returns {Object} 200 - Success response - application/json
 */
router.delete(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPCreate,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'serverName',
  }),
  deleteMCPServerController,
);

module.exports = router;
