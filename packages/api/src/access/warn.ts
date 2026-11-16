import { logger } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import { collectLimits, ruleNames } from './limits';

/**
 * Once at startup, never fatal: warns about each `allowedFor` rule that names nobody and
 * each group name that has no group document. Reads nothing when the file has no limits.
 */
export async function warnOnAccessLimits(
  config: Partial<TCustomConfig> | undefined | null,
  findGroupByName: (name: string) => Promise<unknown>,
): Promise<void> {
  const limits = collectLimits(config);
  if (!limits) {
    return;
  }
  const groups = new Set<string>();
  const maps = [
    ['spec', limits.specs],
    ['endpoint', limits.endpoints],
    ['mcpServer', limits.mcpServers],
  ] as const;
  for (const [kind, map] of maps) {
    for (const [name, rule] of map) {
      const listed = ruleNames(rule);
      if (listed.groups.length === 0 && listed.users.length === 0) {
        logger.warn(`[access] allowedFor on ${kind} "${name}" names nobody; it permits nobody`);
      }
      listed.groups.forEach((group) => groups.add(group));
    }
  }
  for (const group of groups) {
    try {
      if (!(await findGroupByName(group))) {
        logger.warn(`[access] allowedFor names group "${group}", which does not exist`);
      }
    } catch (error) {
      logger.error(`[access] could not look up group "${group}"`, error);
    }
  }
}
