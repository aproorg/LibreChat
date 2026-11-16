import { ErrorTypes } from 'librechat-data-provider';
import type { NextFunction, Request as ServerRequest, Response as ServerResponse } from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import type { AccessKind, AccessRequest, Access } from '~/access';

const MESSAGES: Record<AccessKind, string> = {
  spec: 'You do not have access to this model.',
  endpoint: 'You do not have access to this endpoint.',
  mcpServer: 'You do not have access to this tool server.',
};

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Refuses a chat send with 403 before any model call, tool call or message save when the
 * YAML `allowedFor` limits exclude the caller from the spec, endpoint or MCP servers in the body.
 */
export function createCheckSendAccess({
  getAccess,
}: {
  getAccess: (req: AccessRequest) => Promise<Access | null>;
}) {
  return async (req: ServerRequest, res: ServerResponse, next: NextFunction): Promise<void> => {
    try {
      const access = await getAccess(req as AccessRequest);
      if (access == null) {
        return next();
      }
      const mcp: unknown = req.body?.ephemeralAgent?.mcp;
      let refusal = access.check({
        spec: asString(req.body?.spec),
        endpoint: asString(req.body?.endpoint),
        mcpServers: Array.isArray(mcp)
          ? mcp.filter((n): n is string => typeof n === 'string')
          : null,
      });
      /** A spec pins its own endpoint and tool servers server-side; they are not in the body. */
      const spec = (req as ServerRequest & { config?: AppConfig }).config?.modelSpecs?.list?.find(
        (item) => item.name === req.body?.spec,
      );
      refusal ??= access.check({ endpoint: spec?.preset?.endpoint, mcpServers: spec?.mcpServers });
      if (refusal == null) {
        return next();
      }
      res.status(403).json({
        type: ErrorTypes.ACCESS_REFUSED,
        kind: refusal.kind,
        message: MESSAGES[refusal.kind],
      });
    } catch (err) {
      next(err);
    }
  };
}
