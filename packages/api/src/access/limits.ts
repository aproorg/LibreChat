import {
  Constants,
  ErrorTypes,
  normalizeServerName,
  normalizeEndpointName,
} from 'librechat-data-provider';
import type { TAllowedFor, TCustomConfig } from 'librechat-data-provider';

export interface AccessCaller {
  email: string;
  groups: ReadonlySet<string>;
}

export interface AccessLimits {
  /** Key: model spec name. */
  specs: ReadonlyMap<string, TAllowedFor>;
  /** Key: `normalizeEndpointName(name)`; built-ins by their `EModelEndpoint` value. */
  endpoints: ReadonlyMap<string, TAllowedFor>;
  /** Key: server name. */
  mcpServers: ReadonlyMap<string, TAllowedFor>;
}

export type AccessKind = 'spec' | 'endpoint' | 'mcpServer';

export interface AccessRefusal {
  kind: AccessKind;
  name: string;
}

export class AccessRefusedError extends Error {
  readonly code: ErrorTypes.ACCESS_REFUSED = ErrorTypes.ACCESS_REFUSED;
  readonly refusal: AccessRefusal;

  constructor(refusal: AccessRefusal) {
    super(ErrorTypes.ACCESS_REFUSED);
    this.name = 'AccessRefusedError';
    this.refusal = refusal;
  }
}

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** The strings of a list; anything that is not a list of strings names nobody. */
const strings = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];

/** Names a rule lists, for matching and startup diagnostics. Wrong shapes list nothing. */
export function ruleNames(rule: unknown): { groups: string[]; users: string[] } {
  if (!isRec(rule)) {
    return { groups: [], users: [] };
  }
  return {
    groups: strings(rule.groups).filter((group) => group !== ''),
    users: strings(rule.users)
      .map(normalizeEmail)
      .filter((user) => user !== ''),
  };
}

/** Defensive: a wrong shape or a rule naming nobody permits nobody. */
export function permits(rule: unknown, caller: AccessCaller): boolean {
  const { groups, users } = ruleNames(rule);
  const email = normalizeEmail(caller.email ?? '');
  if (email !== '' && users.includes(email)) {
    return true;
  }
  return groups.some((group) => caller.groups.has(group));
}

const collect = (entries: Iterable<[string, unknown]>): Map<string, TAllowedFor> => {
  const out = new Map<string, TAllowedFor>();
  for (const [key, entry] of entries) {
    if (isRec(entry) && entry.allowedFor !== undefined) {
      out.set(key, entry.allowedFor as TAllowedFor);
    }
  }
  return out;
};

/** Null when the file carries no `allowedFor` key at all. */
export function collectLimits(
  config: Partial<TCustomConfig> | undefined | null,
): AccessLimits | null {
  if (!config) {
    return null;
  }
  const specs = collect(
    (config.modelSpecs?.list ?? []).map((spec): [string, unknown] => [spec.name ?? '', spec]),
  );
  const { custom, ...builtIn } = (config.endpoints ?? {}) as Rec;
  const endpoints = collect(Object.entries(builtIn));
  const customList: unknown[] = Array.isArray(custom) ? custom : [];
  const customRules = collect(
    customList.map((entry): [string, unknown] => [
      normalizeEndpointName(isRec(entry) && typeof entry.name === 'string' ? entry.name : ''),
      entry,
    ]),
  );
  for (const [name, rule] of customRules) {
    endpoints.set(name, rule);
  }
  const mcpServers = collect(Object.entries(config.mcpServers ?? {}));
  if (specs.size === 0 && endpoints.size === 0 && mcpServers.size === 0) {
    return null;
  }
  return { specs, endpoints, mcpServers };
}

export interface AccessTarget {
  spec?: string | null;
  endpoint?: string | null;
  mcpServers?: readonly string[] | null;
}

export interface Access {
  /** The spec's own rule only. */
  allowsSpec(name: string): boolean;
  /** The name is normalized inside. */
  allowsEndpoint(name: string): boolean;
  allowsMcpServer(name: string): boolean;
  /** A combined tool key (`tool_mcp_server`); false when it ends in a limited server's name. */
  allowsMcpTool(toolKey: string): boolean;
  /** First refusal in the order spec, endpoint, mcpServers; null when all pass. */
  check(target: AccessTarget): AccessRefusal | null;
}

/** Rules indexed under each spelling a caller may use; one name can match several rules. */
function indexRules(
  map: ReadonlyMap<string, TAllowedFor>,
  spellings: (key: string) => string[],
): Map<string, TAllowedFor[]> {
  const index = new Map<string, TAllowedFor[]>();
  for (const [key, rule] of map) {
    for (const spelling of spellings(key)) {
      const rules = index.get(spelling) ?? [];
      if (!rules.includes(rule)) {
        rules.push(rule);
      }
      index.set(spelling, rules);
    }
  }
  return index;
}

const endpointKey = (name: string): string => normalizeEndpointName(name).toLowerCase();

/** Provider aliases that `getProviderConfig` (endpoints/config/providers.ts) resolves to a built-in endpoint. */
const ENDPOINT_ALIASES: Record<string, string> = { vertexai: 'google' };

export function createAccess(limits: AccessLimits, caller: AccessCaller): Access {
  const endpointRules = indexRules(limits.endpoints, (key) => [endpointKey(key)]);
  const serverRules = indexRules(limits.mcpServers, (key) => [key, normalizeServerName(key)]);
  /** Every matching rule must permit the caller: several rules fail closed. */
  const passes = (rules: TAllowedFor[] | undefined): boolean =>
    (rules ?? []).every((rule) => permits(rule, caller));
  const access: Access = {
    allowsSpec: (name) => !limits.specs.has(name) || permits(limits.specs.get(name), caller),
    allowsEndpoint(name) {
      const key = endpointKey(name);
      return [key, ENDPOINT_ALIASES[key]].every(
        (k) => k === undefined || passes(endpointRules.get(k)),
      );
    },
    allowsMcpServer: (name) => passes(serverRules.get(name)),
    /** Suffix match, so a server name that itself contains the delimiter cannot be mis-split. */
    allowsMcpTool: (toolKey) =>
      [...serverRules].every(
        ([name, rules]) => !toolKey.endsWith(`${Constants.mcp_delimiter}${name}`) || passes(rules),
      ),
    check({ spec, endpoint, mcpServers }) {
      if (spec && !access.allowsSpec(spec)) {
        return { kind: 'spec', name: spec };
      }
      if (endpoint && !access.allowsEndpoint(endpoint)) {
        return { kind: 'endpoint', name: endpoint };
      }
      const server = mcpServers?.find((name) => !access.allowsMcpServer(name));
      return server === undefined ? null : { kind: 'mcpServer', name: server };
    },
  };
  return access;
}

/** Throws {@link AccessRefusedError} when the caller may not use the endpoint. Null access allows all. */
export function assertEndpointAccess(
  access: Access | null | undefined,
  endpoint: string | null | undefined,
): void {
  if (access && endpoint && !access.allowsEndpoint(endpoint)) {
    throw new AccessRefusedError({ kind: 'endpoint', name: endpoint });
  }
}
