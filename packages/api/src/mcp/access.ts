import { ErrorTypes } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { Access, AccessRequest } from '~/access';

/** Drops the servers the caller may not use. No limits (null access) returns the same object. */
export function filterServersByAccess<T>(
  configs: Record<string, T>,
  access: Access | null,
): Record<string, T> {
  if (!access) {
    return configs;
  }
  return Object.fromEntries(
    Object.entries(configs).filter(([name]) => access.allowsMcpServer(name)),
  );
}

/** A server the caller may not use behaves like one that does not exist. Null access allows all. */
export function isServerAllowed(access: Access | null | undefined, serverName?: string): boolean {
  return !access || !serverName || access.allowsMcpServer(serverName);
}

/** Refuses a `:serverName` route with 403 before the handler runs. Place after auth. */
export function createCheckMcpServerAccess({
  getAccess,
}: {
  getAccess: (req: AccessRequest) => Promise<Access | null>;
}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const access = await getAccess(req);
      if (access && !access.allowsMcpServer(req.params.serverName)) {
        res.status(403).json({ type: ErrorTypes.ACCESS_REFUSED, kind: 'mcpServer' });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
