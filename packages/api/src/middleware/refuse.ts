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

type Body = { spec?: unknown; endpoint?: unknown; ephemeralAgent?: { mcp?: unknown } } | null;

/** Checks one conversation shape: the request body, or its `addedConvo`. */
function refuseBody(access: Access, body: Body | undefined, config?: AppConfig) {
  if (body == null || typeof body !== 'object') {
    return null;
  }
  const mcp: unknown = body.ephemeralAgent?.mcp;
  const refusal = access.check({
    spec: asString(body.spec),
    endpoint: asString(body.endpoint),
    mcpServers: Array.isArray(mcp) ? mcp.filter((n): n is string => typeof n === 'string') : null,
  });
  /** A spec pins its own endpoint and tool servers server-side; they are not in the body. */
  const spec = config?.modelSpecs?.list?.find((item) => item.name === body.spec);
  return (
    refusal ?? access.check({ endpoint: spec?.preset?.endpoint, mcpServers: spec?.mcpServers })
  );
}

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
      const config = (req as ServerRequest & { config?: AppConfig }).config;
      const refusal =
        refuseBody(access, req.body, config) ?? refuseBody(access, req.body?.addedConvo, config);
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

/**
 * Refuses with 403 when the caller may not use the endpoint a route serves.
 * For routes whose endpoint is not in a chat body (assistants).
 */
export function createCheckEndpointAccess({
  getAccess,
  getEndpoint = (req) => asString(req.body?.endpoint) ?? asString(req.query?.endpoint),
}: {
  getAccess: (req: AccessRequest) => Promise<Access | null>;
  /** Defaults to the body or query `endpoint`, the way the assistants controllers resolve it. */
  getEndpoint?: (req: ServerRequest) => string | undefined | null;
}) {
  return async (req: ServerRequest, res: ServerResponse, next: NextFunction): Promise<void> => {
    try {
      const access = await getAccess(req as AccessRequest);
      const endpoint = getEndpoint(req);
      if (access == null || !endpoint || access.allowsEndpoint(endpoint)) {
        return next();
      }
      res.status(403).json({
        type: ErrorTypes.ACCESS_REFUSED,
        kind: 'endpoint',
        message: MESSAGES.endpoint,
      });
    } catch (err) {
      next(err);
    }
  };
}
