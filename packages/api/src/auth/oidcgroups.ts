import { logger, tenantStorage, getTenantId } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '~/utils/errors';

const MAX_GROUP_ID_LENGTH = 256;
const MAX_GROUP_IDS = 500;
/**
 * A refresh may hand back the id token of an earlier login when the IdP sends no new one.
 * Its group list is old news and must not re-add a membership the IdP has since removed.
 */
const MAX_CLAIMS_AGE_SECONDS = 600;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** One rule for claim values and for share-path ids: trimmed, non-empty, bounded, no control chars. */
export function normalizeGroupId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const id = value.trim();
  if (!id || id.length > MAX_GROUP_ID_LENGTH || CONTROL_CHARS.test(id)) {
    return null;
  }
  return id;
}

/** Accepts a string or an array of strings; returns valid, de-duplicated ids capped at 500. */
export function parseGroupClaim(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  const ids = new Set<string>();
  for (const value of values) {
    const id = normalizeGroupId(value);
    if (id) {
      ids.add(id);
    }
  }
  if (ids.size > MAX_GROUP_IDS) {
    logger.warn(`[oidcGroups] Group claim has ${ids.size} valid values; keeping ${MAX_GROUP_IDS}`);
    return [...ids].slice(0, MAX_GROUP_IDS);
  }
  return [...ids];
}

export type OidcGroupSyncUser = { _id?: unknown; idOnTheSource?: string; tenantId?: string };

export type SyncOidcGroupsParams = {
  /** Configured claim name (`openidGroupsClaim`); the sync is off when unset. */
  claimName?: string;
  /** Verified token claims for this login or refresh. Never request data. */
  claims?: Record<string, unknown> | null;
  user: OidcGroupSyncUser;
  syncUserOidcGroups: (params: {
    memberId: string;
    groupIds: string[];
    tenantId?: string;
  }) => Promise<{ added: number; removed: number }>;
};

/**
 * Best-effort, like the Entra login sync: a failure is logged and never grants access.
 * Unlike Entra, a missing claim means "no groups" and removes every 'oidc' membership;
 * claims without a subject or not issued in the last ten minutes are not treated as an answer.
 */
export async function syncOidcGroups(params: SyncOidcGroupsParams): Promise<void> {
  const { claimName, claims, user, syncUserOidcGroups } = params;
  if (!claimName) {
    return;
  }
  if (!claims || typeof claims.sub !== 'string') {
    logger.debug('[oidcGroups] No verified claims; group sync skipped');
    return;
  }
  if (typeof claims.iat !== 'number' || Date.now() / 1000 - claims.iat > MAX_CLAIMS_AGE_SECONDS) {
    logger.warn('[oidcGroups] Claims are not freshly issued; group membership may be stale');
    return;
  }
  const userId = user._id != null ? String(user._id) : undefined;
  /** Same key the read path uses (`getUserPrincipals`, `findGroupsByMemberId`). */
  const memberId = user.idOnTheSource || userId;
  if (!memberId) {
    return;
  }
  const groupIds = parseGroupClaim(claims[claimName]);
  /** Explicit scope: the data methods filter on it even under SYSTEM scope or with no ambient tenant. */
  const tenantId = user.tenantId ? String(user.tenantId) : undefined;
  const run = async () => {
    try {
      const { added, removed } = await syncUserOidcGroups({ memberId, groupIds, tenantId });
      logger.debug(
        `[oidcGroups] Synced ${groupIds.length} groups (added ${added}, removed ${removed})`,
      );
    } catch (error) {
      logger.error(
        '[oidcGroups] Group sync failed; group membership may be stale',
        getSafeErrorMetadata(error),
      );
    }
  };
  /** Without an ambient tenant (tenant-less deployments set none), run under the user's own. */
  if (!tenantId || getTenantId() != null) {
    return run();
  }
  return tenantStorage.run({ tenantId, userId }, run);
}

export type SyncOidcGroupsFromConfigParams = Omit<SyncOidcGroupsParams, 'claimName'> & {
  getAppConfig: (options: {
    baseOnly: true;
  }) => Promise<{ config?: { openidGroupsClaim?: string } } | null | undefined>;
};

/** Reads the base-config claim name, then syncs. Never throws: a failure must not fail the login or refresh. */
export async function syncOidcGroupsFromConfig(
  params: SyncOidcGroupsFromConfigParams,
): Promise<void> {
  const { getAppConfig, ...rest } = params;
  try {
    const baseConfig = await getAppConfig({ baseOnly: true });
    await syncOidcGroups({ ...rest, claimName: baseConfig?.config?.openidGroupsClaim });
  } catch (error) {
    logger.error(
      '[oidcGroups] Group sync failed; group membership may be stale',
      getSafeErrorMetadata(error),
    );
  }
}

type OidcSharePrincipal = { source?: string; idOnTheSource?: unknown } & Record<string, unknown>;

/** Share path: resolves or creates the empty 'oidc' group for a validated id. Never writes members. */
export async function ensureOidcSharedGroup(params: {
  principal: OidcSharePrincipal;
  tenantId?: string;
  ensureOidcGroup: (idOnTheSource: string, tenantId?: string) => Promise<string>;
}): Promise<string> {
  const idOnTheSource = normalizeGroupId(params.principal.idOnTheSource);
  if (!idOnTheSource) {
    throw new Error('OIDC group principals must have a valid idOnTheSource');
  }
  return params.ensureOidcGroup(idOnTheSource, params.tenantId);
}

/** With the feature on, body-supplied name/email/description/avatar are dropped for 'oidc' groups. */
export function sanitizeOidcSharePrincipal<T extends OidcSharePrincipal>(
  principal: T,
  claimName?: string,
): T {
  if (!claimName || principal.source !== 'oidc') {
    return principal;
  }
  return {
    ...principal,
    name: undefined,
    email: undefined,
    description: undefined,
    avatar: undefined,
  };
}
