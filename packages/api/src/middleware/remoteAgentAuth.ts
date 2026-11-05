import { SystemRoles } from 'librechat-data-provider';
import { getTenantId, logger, tenantStorage, SystemCapabilities } from '@librechat/data-schemas';
import type { AppConfig, IUser, RoleMethods, UserMethods } from '@librechat/data-schemas';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { JwtPayload } from 'jsonwebtoken';
import type { GetAppConfigOptions } from '../app/service';
import type { HasCapabilityFn } from './capabilities';
import type { ServerRequest } from '~/types/http';
import type { ContextRequest } from './tenant';
import {
  getLibreChatRolesForOpenIdSync,
  getOpenIdRolesForOpenIdSync,
  getOpenIdRoleSyncOptions,
  selectOpenIdRole,
} from '../auth/openidRoleSync';
import { clearOidcAccessTokenCache, extractBearerToken, verifyOidcAccessToken } from '../auth/oidc';
import { findOpenIDUser, getOpenIdEmail, normalizeOpenIdIssuer } from '../auth/openid';
import { tenantContextMiddleware } from './tenant';

export interface RemoteAgentAuthDeps {
  apiKeyMiddleware: RequestHandler;
  findUser: UserMethods['findUser'];
  getRolesByNames: RoleMethods['findRolesByNames'];
  updateUser: UserMethods['updateUser'];
  /** Atomically sets `remoteAgentOid` if unset; false when refused (already linked / oid taken). */
  linkRemoteAgentOid: UserMethods['linkRemoteAgentOid'];
  isPrincipalActive: (userId: string) => Promise<boolean>;
  /** Used to refuse first-linking capability-based admins (any principal: user, group, role). */
  hasCapability: HasCapabilityFn;
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
}

type OidcConfig = NonNullable<
  NonNullable<NonNullable<TAgentsEndpoint['remoteApi']>['auth']>['oidc']
>;

type AgentAuthConfig = NonNullable<NonNullable<TAgentsEndpoint['remoteApi']>['auth']>;
type EnabledOidcConfig = OidcConfig & { audience: string; issuer: string };
type ScopeClaim = string | string[] | undefined;
type UserResolution =
  | { status: 'resolved'; user: IUser; updateData: Partial<IUser>; linkOid?: string }
  | { status: 'missing' }
  | { status: 'rejected'; error: string };

export function clearRemoteAgentAuthCache(): void {
  clearOidcAccessTokenCache();
}

function splitScopes(scopes: string): string[] {
  return scopes.trim().split(/\s+/).filter(Boolean);
}

function getTokenScopes(scopeClaim: ScopeClaim): string[] {
  if (Array.isArray(scopeClaim)) return scopeClaim.flatMap(splitScopes);
  return scopeClaim ? splitScopes(scopeClaim) : [];
}

function hasRequiredScopes(requiredScope: string | undefined, payload: JwtPayload): boolean {
  if (!requiredScope) return true;

  const requiredScopes = splitScopes(requiredScope);
  if (requiredScopes.length === 0) return true;

  const rawScope = (payload['scp'] ?? payload['scope']) as ScopeClaim;
  const tokenScopes = getTokenScopes(rawScope);
  return requiredScopes.every((scope) => tokenScopes.includes(scope));
}

function verifyRemoteOidcAccessToken(
  token: string,
  oidcConfig: EnabledOidcConfig,
): Promise<JwtPayload> {
  return verifyOidcAccessToken(token, oidcConfig, { useOpenIdJwksEnv: true });
}

function getConfigOptions(req: Request): GetAppConfigOptions {
  const user = req.user as { tenantId?: string } | undefined;
  const tenantId = user?.tenantId ?? getTenantId();

  if (tenantId) return { tenantId };
  return { baseOnly: true };
}

function getUserConfigOptions(user: IUser): GetAppConfigOptions {
  if (user.tenantId) return { role: user.role, userId: user.id, tenantId: user.tenantId };
  return { baseOnly: true };
}

function isResolvedUserConfigScope(initialOptions: GetAppConfigOptions, user: IUser): boolean {
  const userOptions = getUserConfigOptions(user);
  return (
    initialOptions.tenantId === userOptions.tenantId &&
    initialOptions.userId === userOptions.userId &&
    initialOptions.role === userOptions.role &&
    initialOptions.baseOnly === userOptions.baseOnly
  );
}

function getRemoteAuthConfig(config: AppConfig): AgentAuthConfig | undefined {
  return config.endpoints?.agents?.remoteApi?.auth;
}

function getEnabledOidcConfig(
  authConfig: AgentAuthConfig | undefined,
): EnabledOidcConfig | undefined {
  if (authConfig?.oidc?.enabled !== true) return undefined;
  if (!authConfig.oidc.issuer) throw new Error('OIDC issuer is required when OIDC auth is enabled');
  if (!authConfig.oidc.audience) {
    throw new Error('OIDC audience is required when OIDC auth is enabled');
  }
  return {
    ...authConfig.oidc,
    audience: authConfig.oidc.audience,
    issuer: authConfig.oidc.issuer,
  };
}

function isApiKeyEnabled(config: AppConfig): boolean {
  return getRemoteAuthConfig(config)?.apiKey?.enabled !== false;
}

function rejectTenantContextConflict(
  requestTenantId: string | undefined,
  userTenantId: string | undefined,
  res: Response,
): boolean {
  if (!requestTenantId || !userTenantId || requestTenantId === userTenantId) {
    return false;
  }

  logger.warn('[remoteAgentAuth] Authenticated user tenant conflicts with request tenant context');
  res.status(401).json({ error: 'Unauthorized' });
  return true;
}

function continueWithAuthenticatedTenantContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestTenantId = getTenantId();
  const userTenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;

  if (rejectTenantContextConflict(requestTenantId, userTenantId, res)) {
    return;
  }

  const contextRequest = req as ContextRequest;
  if (requestTenantId) {
    contextRequest.tenantId = requestTenantId;
  }
  tenantContextMiddleware(req as ServerRequest, res, next);
}

async function enforceApiKeyTenantPolicy(
  req: Request,
  res: Response,
  next: NextFunction,
  getAppConfig: RemoteAgentAuthDeps['getAppConfig'],
): Promise<void> {
  const userTenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;
  if (rejectTenantContextConflict(getTenantId(), userTenantId, res)) {
    return;
  }

  const config = await getAppConfig(getConfigOptions(req));

  if (!isApiKeyEnabled(config)) {
    logger.warn('[remoteAgentAuth] API key rejected by resolved tenant auth policy');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  continueWithAuthenticatedTenantContext(req, res, next);
}

async function runApiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  apiKeyMiddleware: RequestHandler,
  getAppConfig: RemoteAgentAuthDeps['getAppConfig'],
): Promise<void> {
  let postAuth: Promise<void> | undefined;

  const wrappedNext: NextFunction = (err?: unknown) => {
    if (err != null) {
      next(err);
      return;
    }

    postAuth = enforceApiKeyTenantPolicy(req, res, next, getAppConfig);
  };

  await Promise.resolve(apiKeyMiddleware(req, res, wrappedNext));
  if (postAuth) await postAuth;
}

async function enforceOidcTenantPolicy(
  token: string,
  user: IUser,
  initialOptions: GetAppConfigOptions,
  getAppConfig: RemoteAgentAuthDeps['getAppConfig'],
): Promise<boolean> {
  if (isResolvedUserConfigScope(initialOptions, user)) return true;

  const config = await getAppConfig(getUserConfigOptions(user));
  const oidcConfig = getEnabledOidcConfig(getRemoteAuthConfig(config));
  if (!oidcConfig) {
    logger.warn('[remoteAgentAuth] OIDC rejected by resolved tenant auth policy');
    return false;
  }

  try {
    const payload = await verifyRemoteOidcAccessToken(token, oidcConfig);
    if (hasRequiredScopes(oidcConfig.scope, payload)) return true;
    logger.warn(
      `[remoteAgentAuth] Token missing resolved tenant required scope: ${oidcConfig.scope}`,
    );
  } catch (err) {
    logger.warn('[remoteAgentAuth] OIDC token rejected by resolved tenant auth policy:', err);
  }

  return false;
}

/** Link config; all three env vars are required (flag, email domains, federated IdP names). */
function getLinkConfig(): { domains: string[]; idps: string[] } | undefined {
  if (process.env.REMOTE_AGENTS_LINK_LOGIN_ACCOUNT_BY_OID !== 'true') return undefined;
  const domains = (process.env.REMOTE_AGENTS_LINK_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  // provider names are compared exactly (case-sensitive)
  const idps = (process.env.REMOTE_AGENTS_LINK_FEDERATED_IDPS ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  return domains.length > 0 && idps.length > 0 ? { domains, idps } : undefined;
}

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Exact-domain check on a lowercase `preferred_username`; rejects whitespace, extra `@`, trailing dot. */
function allowedLinkEmail(value: unknown, domains: string[]): string | undefined {
  // ASCII only: toLowerCase() folds e.g. U+212A (Kelvin sign) onto ASCII 'k'
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) return undefined;
  const email = value.toLowerCase();
  if (/\s/.test(email) || email.split('@').length !== 2) return undefined;
  const [local, domain] = email.split('@');
  return local && domain && !domain.endsWith('.') && domains.includes(domain) ? email : undefined;
}

/**
 * Opt-in: resolves an Entra token to the existing browser-login account (bound to a different
 * issuer, e.g. Cognito). Later calls match by `remoteAgentOid`; the first call links by
 * `preferred_username` (domain-allowlisted, tenant-checked). The link itself is persisted by the
 * caller after all policy checks pass. Never touches openidId/openidIssuer/provider/email.
 */
async function linkLoginAccountByOid(
  payload: JwtPayload,
  oidcConfig: EnabledOidcConfig,
  findUser: UserMethods['findUser'],
  firstLink: boolean,
  hasCapability: HasCapabilityFn,
): Promise<Extract<UserResolution, { status: 'resolved' }> | undefined> {
  const config = getLinkConfig();
  const domains = config?.domains;
  const oid = payload['oid'];
  const loginIssuer = normalizeOpenIdIssuer(process.env.OPENID_ISSUER);
  if (!config || !domains || typeof oid !== 'string' || oid.trim() === '' || !loginIssuer)
    return undefined;
  // Same login and remote issuer: findOpenIDUser's sub/oid guard is authoritative; linking only
  // makes sense across issuers.
  if (loginIssuer === normalizeOpenIdIssuer(oidcConfig.issuer)) return undefined;

  const isLoginAccount = (user: IUser | null | undefined): user is IUser =>
    user != null &&
    user.provider === 'openid' &&
    Boolean(user.openidId) &&
    normalizeOpenIdIssuer(user.openidIssuer) === loginIssuer;
  const resolved = (user: IUser, linkOid?: string) => {
    user.id = String(user._id);
    const updateData: Partial<IUser> = {};
    if (!user.role) {
      user.role = SystemRoles.USER;
      updateData.role = SystemRoles.USER;
    }
    return { status: 'resolved' as const, user, updateData, linkOid };
  };

  const byOid = await findUser({ remoteAgentOid: oid });
  if (!firstLink) return isLoginAccount(byOid) ? resolved(byOid) : undefined;
  // oid already on some (non-login) account: never fall through to the email link
  if (byOid) return undefined;

  const tenantGuid = oidcConfig.issuer.match(GUID_RE)?.[0].toLowerCase();
  const tid = payload['tid'];
  if (!tenantGuid || typeof tid !== 'string' || tid.toLowerCase() !== tenantGuid) return undefined;
  const email = allowedLinkEmail(payload['preferred_username'], domains);
  if (!email) return undefined;

  const user = await findUser({ email });
  // legacy (empty-issuer) accounts are not linked: findOpenIDUser would re-bind them on next call
  if (!isLoginAccount(user)) return undefined;
  // Native pool users can edit their own email, so only accounts whose latest browser login came
  // through a trusted federated IdP (verified ID-token `identities` claim) may be first-linked.
  if (!user.openidFederatedIdp || !config.idps.includes(user.openidFederatedIdp)) {
    logger.warn(
      '[remoteAgentAuth] link refused: account did not log in through a trusted federated IdP',
    );
    return undefined;
  }
  if (user.remoteAgentOid) {
    logger.warn('[remoteAgentAuth] link refused: account already linked to a different oid');
    return undefined;
  }
  // A stored Entra oid that differs from the caller's is proof of a different person.
  if (user.idOnTheSource && user.idOnTheSource !== oid) {
    logger.warn('[remoteAgentAuth] link refused: account stores a different Entra oid');
    return undefined;
  }
  // emailVerified is deliberately NOT required: accounts federated through Cognito never carry
  // email_verified, so it is false for everyone. The matched value is the token's preferred_username
  // (UPN, admin-controlled in the pinned tenant), the same value Cognito copied into the stored email.
  // Residual risk: preferred_username is mutable (UPN reuse); never first-link a privileged account.
  // Admin power is capability-based (user/group/role grants), so check ACCESS_ADMIN too; fail closed.
  let privileged = user.role === SystemRoles.ADMIN;
  if (!privileged) {
    try {
      const check = () =>
        hasCapability(
          { id: String(user._id), role: user.role ?? SystemRoles.USER, tenantId: user.tenantId },
          SystemCapabilities.ACCESS_ADMIN,
        );
      privileged =
        user.tenantId && getTenantId() !== user.tenantId
          ? await tenantStorage.run({ tenantId: user.tenantId }, check)
          : await check();
    } catch (err) {
      logger.error('[remoteAgentAuth] admin capability check failed; refusing link', err);
      privileged = true;
    }
  }
  if (privileged) {
    logger.warn('[remoteAgentAuth] link refused: admin accounts are not linked by username');
    return undefined;
  }
  return resolved(user, oid);
}

async function resolveUser(
  token: string,
  payload: JwtPayload,
  oidcConfig: EnabledOidcConfig,
  findUser: UserMethods['findUser'],
  hasCapability: HasCapabilityFn,
): Promise<UserResolution> {
  if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    return { status: 'rejected', error: 'missing_sub_claim' };
  }

  // Steady state: match by the immutable oid first so linked calls never hit the email fallback
  // (which logs the full email and a spurious "Rejected email fallback" warning).
  const byOid = await linkLoginAccountByOid(payload, oidcConfig, findUser, false, hasCapability);
  if (byOid) {
    byOid.user.federatedTokens = {
      access_token: token,
      ...(payload.exp != null ? { expires_at: payload.exp } : {}),
    };
    return byOid;
  }

  const { user, error, migration } = await findOpenIDUser({
    findUser,
    email: getOpenIdEmail(payload, 'remoteAgentAuth'),
    openidId: payload.sub,
    openidIssuer: oidcConfig.issuer,
    idOnTheSource: payload['oid'] as string | undefined,
    strategyName: 'remoteAgentAuth',
  });

  if (error != null || user == null) {
    const linked = await linkLoginAccountByOid(payload, oidcConfig, findUser, true, hasCapability);
    if (linked) {
      linked.user.federatedTokens = {
        access_token: token,
        ...(payload.exp != null ? { expires_at: payload.exp } : {}),
      };
      return linked;
    }
    return error != null ? { status: 'rejected', error } : { status: 'missing' };
  }

  user.id = String(user._id);

  const updateData: Partial<IUser> = {};

  if (migration) {
    updateData.provider = 'openid';
    updateData.openidId = payload.sub;
    updateData.openidIssuer = normalizeOpenIdIssuer(oidcConfig.issuer);
  }

  if (!user.role) {
    user.role = SystemRoles.USER;
    updateData.role = SystemRoles.USER;
  }

  user.federatedTokens = {
    access_token: token,
    ...(payload.exp != null ? { expires_at: payload.exp } : {}),
  };
  return { status: 'resolved', user, updateData };
}

async function selectOpenIdRoleForOpenIdSync(
  payload: JwtPayload,
  user: IUser,
  getRolesByNames: RemoteAgentAuthDeps['getRolesByNames'],
): Promise<string | undefined> {
  const options = getOpenIdRoleSyncOptions();
  if (!options.enabled || !options.apiEnabled) {
    return;
  }

  if (user.role === SystemRoles.ADMIN) {
    logger.info(
      `[remoteAgentAuth] OpenID role sync skipped for ${user.id}; existing ADMIN role is not managed by generic role sync`,
    );
    return;
  }

  if (options.claimSource !== 'access') {
    logger.warn(
      `[remoteAgentAuth] OpenID role sync skipped; source '${options.claimSource}' is not available for API auth`,
    );
    return;
  }

  const openIdRoleValues = await getOpenIdRolesForOpenIdSync({
    options,
    accessClaims: payload,
    decodeToken: () => payload,
    resolveGroupOverage: async () => [],
  });
  if (openIdRoleValues === undefined) {
    logger.warn(
      `[remoteAgentAuth] OpenID role sync skipped; claim '${options.claim}' was not found or invalid`,
    );
    return;
  }

  const loadLibreChatRoles = async () =>
    getLibreChatRolesForOpenIdSync({
      getRolesByNames,
      rolePriority: options.rolePriority,
      fallbackRole: options.fallbackRole,
      logPrefix: '[remoteAgentAuth]',
    });
  const { rolePriority, fallbackRole } =
    user.tenantId && getTenantId() !== user.tenantId
      ? await tenantStorage.run({ tenantId: user.tenantId }, loadLibreChatRoles)
      : await loadLibreChatRoles();
  const result = selectOpenIdRole({
    currentRole: user.role,
    openIdRoleValues,
    rolePriority,
    fallbackRole,
  });

  if (!result.selectedRole || result.selectedRole === user.role) {
    return;
  }

  logger.info(
    `[remoteAgentAuth] OpenID role sync selected role for ${user.id}: ${user.role || 'unset'} -> ${result.selectedRole}`,
  );
  return result.selectedRole;
}

async function updateResolvedUser(
  userResolution: Extract<UserResolution, { status: 'resolved' }>,
  updateUser: RemoteAgentAuthDeps['updateUser'],
): Promise<void> {
  if (Object.keys(userResolution.updateData).length === 0) {
    return;
  }

  const update = async () => updateUser(userResolution.user.id, userResolution.updateData);
  if (userResolution.user.tenantId && getTenantId() !== userResolution.user.tenantId) {
    await tenantStorage.run({ tenantId: userResolution.user.tenantId }, update);
    return;
  }

  await update();
}

/**
 * Factory for Remote Agent API auth middleware.
 *
 * Validates Bearer tokens against configured OIDC issuer via JWKS,
 * falling back to API key auth when enabled. Stateless — no session dependency.
 *
 * ```yaml
 * endpoints:
 *   agents:
 *     remoteApi:
 *       auth:
 *         apiKey:
 *           enabled: false
 *         oidc:
 *           enabled: true
 *           issuer: <issuer>
 *           jwksUri: <jwksUri>
 *           audience: <audience>
 *           scope: <scope>
 * ```
 */
export function createRemoteAgentAuth({
  apiKeyMiddleware,
  findUser,
  getRolesByNames,
  updateUser,
  linkRemoteAgentOid,
  isPrincipalActive,
  hasCapability,
  getAppConfig,
}: RemoteAgentAuthDeps): RequestHandler {
  /**
   * Annotated as `express.Request` (and helpers below take the same type)
   * so the local `Request.user` augmentation in `src/types/express.d.ts`
   * applies inside the closure. The closure is then cast to
   * `RequestHandler` at the return — `RequestHandler`'s internal
   * `Request` resolves through `express-serve-static-core` and lacks the
   * augmentation, so a direct return would mismatch on `user`.
   */
  const handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const initialConfigOptions = getConfigOptions(req);
      const config = await getAppConfig(initialConfigOptions);
      const authConfig = getRemoteAuthConfig(config);
      const apiKeyEnabled = isApiKeyEnabled(config);

      if (authConfig?.oidc?.enabled !== true) {
        if (apiKeyEnabled) {
          await runApiKeyAuth(req, res, next, apiKeyMiddleware, getAppConfig);
          return;
        }
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      if (!authConfig.oidc.issuer) {
        logger.error('[remoteAgentAuth] OIDC issuer is required when OIDC auth is enabled');
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      if (!authConfig.oidc.audience) {
        logger.error('[remoteAgentAuth] OIDC audience is required when OIDC auth is enabled');
        res.status(500).json({ error: 'Internal server error' });
        return;
      }

      const oidcConfig = getEnabledOidcConfig(authConfig);
      if (!oidcConfig) throw new Error('OIDC configuration is required when OIDC auth is enabled');

      const token = extractBearerToken(req.headers.authorization);
      if (token == null) {
        if (apiKeyEnabled) {
          await runApiKeyAuth(req, res, next, apiKeyMiddleware, getAppConfig);
          return;
        }
        res.status(401).json({ error: 'Bearer token required' });
        return;
      }

      let payload: JwtPayload;

      try {
        payload = await verifyRemoteOidcAccessToken(token, oidcConfig);
        if (!hasRequiredScopes(oidcConfig.scope, payload)) {
          logger.warn(`[remoteAgentAuth] Token missing required scope: ${oidcConfig.scope}`);
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
      } catch (oidcErr) {
        if (apiKeyEnabled) {
          logger.debug('[remoteAgentAuth] OIDC verification failed; trying API key auth:', oidcErr);
          await runApiKeyAuth(req, res, next, apiKeyMiddleware, getAppConfig);
          return;
        }
        logger.error('[remoteAgentAuth] OIDC verification failed:', oidcErr);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const userResolution = await resolveUser(token, payload, oidcConfig, findUser, hasCapability);

      if (userResolution.status === 'rejected') {
        logger.warn(`[remoteAgentAuth] OpenID user rejected: ${userResolution.error}`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (userResolution.status === 'missing') {
        logger.warn('[remoteAgentAuth] OIDC token valid but no matching LibreChat user');
        if (apiKeyEnabled) {
          await runApiKeyAuth(req, res, next, apiKeyMiddleware, getAppConfig);
          return;
        }
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (rejectTenantContextConflict(getTenantId(), userResolution.user.tenantId, res)) {
        return;
      }

      if (
        !(await enforceOidcTenantPolicy(
          token,
          userResolution.user,
          initialConfigOptions,
          getAppConfig,
        ))
      ) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const selectedRole = await selectOpenIdRoleForOpenIdSync(
        payload,
        userResolution.user,
        getRolesByNames,
      );
      const roleChanged = Boolean(selectedRole);
      if (selectedRole) {
        userResolution.user.role = selectedRole;
        userResolution.updateData.role = selectedRole;
      }

      if (
        roleChanged &&
        !(await enforceOidcTenantPolicy(
          token,
          userResolution.user,
          initialConfigOptions,
          getAppConfig,
        ))
      ) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (!(await isPrincipalActive(userResolution.user.id))) {
        res.status(409).json({
          error: 'Account deletion is in progress',
          code: 'ACCOUNT_DELETION_IN_PROGRESS',
        });
        return;
      }

      if (userResolution.linkOid) {
        const { user, linkOid } = userResolution;
        const link = () => linkRemoteAgentOid(user.id, linkOid);
        const linked =
          user.tenantId && getTenantId() !== user.tenantId
            ? await tenantStorage.run({ tenantId: user.tenantId }, link)
            : await link();
        if (!linked) {
          logger.warn('[remoteAgentAuth] link refused: account or oid already linked');
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        logger.info(
          `[remoteAgentAuth] Linked remote OIDC oid to existing login account ${user.id}`,
        );
      }

      await updateResolvedUser(userResolution, updateUser);

      req.user = userResolution.user;
      return continueWithAuthenticatedTenantContext(req, res, next);
    } catch (err) {
      logger.error('[remoteAgentAuth] Unexpected error', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
  };
  return handler as RequestHandler;
}
