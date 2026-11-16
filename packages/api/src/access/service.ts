import type { AppConfig } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from '~/app/service';
import type { Access, AccessLimits } from './limits';
import { collectLimits, createAccess } from './limits';

export interface AccessServiceDeps {
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  /** Takes the user id only: it resolves Entra members through the user's own source id. */
  getUserGroups: (userId: string) => Promise<Array<{ name: string }>>;
  /** Email of a user known only by id; read only when the file carries limits. */
  getUserEmail?: (userId: string) => Promise<string | undefined>;
}

export interface AccessUser {
  id?: string;
  email?: string;
  tenantId?: string;
}

export interface AccessRequest {
  user?: AccessUser | null;
}

export interface AccessService {
  getAccess(req: AccessRequest): Promise<Access | null>;
  /** For run-time seams that carry a user id and maybe no email. Not memoized. */
  getAccessForUser(userId: string | undefined, user?: AccessUser | null): Promise<Access | null>;
}

/**
 * Limits come only from the YAML file as loaded (`baseOnly`), never from the merged
 * per-user config or stored overrides. A failed group lookup rejects; it is never "permitted".
 */
export function createAccessService(deps: AccessServiceDeps): AccessService {
  const limitsByConfig = new WeakMap<object, AccessLimits | null>();
  const accessByRequest = new WeakMap<object, Promise<Access | null>>();

  async function resolve(user: AccessUser | null | undefined): Promise<Access | null> {
    const appConfig = await deps.getAppConfig({ baseOnly: true, tenantId: user?.tenantId });
    const config = appConfig?.config;
    if (!config) {
      return null;
    }
    if (!limitsByConfig.has(config)) {
      limitsByConfig.set(config, collectLimits(config));
    }
    const limits = limitsByConfig.get(config);
    if (!limits) {
      return null;
    }
    const [groups, email] = await Promise.all([
      user?.id ? deps.getUserGroups(user.id) : [],
      user?.email ?? (user?.id ? deps.getUserEmail?.(user.id) : undefined),
    ]);
    return createAccess(limits, {
      email: email ?? '',
      groups: new Set(groups.map((group) => group.name)),
    });
  }

  return {
    getAccess(req: AccessRequest): Promise<Access | null> {
      let pending = accessByRequest.get(req);
      if (!pending) {
        pending = resolve(req.user);
        accessByRequest.set(req, pending);
      }
      return pending;
    },
    getAccessForUser: (userId, user) => resolve({ ...user, id: userId }),
  };
}
