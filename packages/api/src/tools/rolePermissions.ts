import { logger } from '@librechat/data-schemas';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { Request as ServerRequest } from 'express';
import type { CheckAccessParams } from '../middleware/access';
import { checkAccessWithRequestCache } from '../middleware/access';

export interface CheckWebSearchGrantParams {
  req?: ServerRequest;
  user?: CheckAccessParams['user'] | null;
  getRoleByName: CheckAccessParams['getRoleByName'];
  /** Prefix for the denial log line, e.g. `loadAgentTools`. */
  context?: string;
}

/**
 * Whether the requesting user's role grants `WEB_SEARCH.USE`.
 *
 * `web_search` reaches a provider by two routes — an `agent.tools` entry, and a
 * `model_parameters` field that turns on the provider's own search without
 * passing through the tool loader — so both have to consult this rather than the
 * deployment capability alone.
 *
 * Resolved through the per-request permission cache, so repeat checks within one
 * request cost no extra role read. Fails closed: a missing user or a lookup that
 * throws denies the tool.
 */
export async function checkWebSearchGrant({
  req,
  user,
  getRoleByName,
  context = 'webSearchGrant',
}: CheckWebSearchGrantParams): Promise<boolean> {
  const subject = (user ?? req?.user) as CheckAccessParams['user'] | undefined;
  try {
    return await checkAccessWithRequestCache({
      req,
      user: subject as CheckAccessParams['user'],
      permissionType: PermissionTypes.WEB_SEARCH,
      permissions: [Permissions.USE],
      getRoleByName,
    });
  } catch (error) {
    logger.error(
      `[${context}][User: ${subject?.id}] Failed ${PermissionTypes.WEB_SEARCH} permission check`,
      error,
    );
    return false;
  }
}
