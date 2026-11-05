import { randomUUID } from 'node:crypto';
import type { SearchMethods, SearchSourceCollection } from '@librechat/data-schemas';
import { BACKFILL_KEYS, JOB_STATE_READ, SOURCE_COLLECTIONS } from './control';

export type SearchScriptMethods = Pick<
  SearchMethods,
  | 'readSearchState'
  | 'writeSearchState'
  | 'searchStateExists'
  | 'listSearchJobRequests'
  | 'readSearchSourceTenants'
>;

const REQUEST_COMMANDS = ['backfill', 'pause', 'resume', 'verify'] as const;
const USAGE = 'Usage: search-job <status|backfill|pause|resume|verify>';
/** A rate older than this came from a process that stopped, so it predicts nothing. */
const RATE_STALE_MS = 5 * 60_000;

export interface SearchCollectionStatus {
  status: string | null;
  processed: number;
  /** An estimate taken when the walk started. */
  total: number | null;
  skipped: number;
  /** Rows that should have a record, where a language pack threw. Verification fails on these. */
  analysisFailures: number;
  /** Source rows per second, or `null` when nothing is running. */
  rate: number | null;
  estimatedFinish: Date | null;
}

export interface SearchJobStatus {
  chain: {
    step: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    /** Failed attempts since the chain last moved. Above zero, the chain is retrying. */
    failures: number;
    lastFailureAt: Date | null;
  };
  paused: boolean;
  collections: Record<SearchSourceCollection, SearchCollectionStatus>;
  verification: Record<string, unknown> | null;
  leaseHeld: boolean;
  pendingRequests: string[];
  /** `null` when the read timed out, so a slow `distinct` cannot hide a running job's progress. */
  tenants: string[] | null;
}

const dateOf = (value: unknown): Date | null => (value instanceof Date ? value : null);
const numberOf = (value: unknown): number | null => (typeof value === 'number' ? value : null);

function collectionStatus(
  entry: Record<string, unknown> | null,
  now: number,
): SearchCollectionStatus {
  const processed = numberOf(entry?.processed) ?? 0;
  const total = numberOf(entry?.total);
  const savedRate = numberOf(entry?.rate) ?? 0;
  const rateAt = dateOf(entry?.rateAt)?.getTime() ?? 0;
  const rate =
    entry?.status === 'running' && savedRate > 0 && now - rateAt < RATE_STALE_MS ? savedRate : null;
  return {
    status: typeof entry?.status === 'string' ? entry.status : null,
    processed,
    total,
    skipped: numberOf(entry?.skipped) ?? 0,
    analysisFailures: numberOf(entry?.analysisFailures) ?? 0,
    rate,
    estimatedFinish:
      rate !== null && total !== null
        ? new Date(now + (Math.max(total - processed, 0) / rate) * 1000)
        : null,
  };
}

/** Only reads. Works before search data is on, since a read of an absent collection is empty. */
export async function readSearchJobStatus(
  methods: SearchScriptMethods,
  now: number = Date.now(),
): Promise<SearchJobStatus> {
  const read = (key: string) => methods.readSearchState(key, JOB_STATE_READ);
  const [chain, messages, conversations, verification, lease, requests, tenants] =
    await Promise.all([
      read('chain'),
      read(BACKFILL_KEYS.messages),
      read(BACKFILL_KEYS.conversations),
      read('verification'),
      read('lease'),
      methods.listSearchJobRequests(),
      methods.readSearchSourceTenants().catch(() => null),
    ]);
  return {
    chain: {
      step: typeof chain?.step === 'string' ? chain.step : null,
      startedAt: dateOf(chain?.startedAt),
      finishedAt: dateOf(chain?.finishedAt),
      failures: numberOf(chain?.failures) ?? 0,
      lastFailureAt: dateOf(chain?.lastFailureAt),
    },
    paused: messages?.pause === true,
    collections: {
      messages: collectionStatus(messages, now),
      conversations: collectionStatus(conversations, now),
    },
    verification,
    leaseHeld: (dateOf(lease?.leaseUntil)?.getTime() ?? 0) > now,
    pendingRequests: requests.map(({ job }) => String(job)),
    tenants,
  };
}

const show = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '-';
  }
  return value instanceof Date ? value.toISOString() : String(value);
};

export function formatSearchJobStatus(status: SearchJobStatus): string[] {
  const { chain, collections, verification } = status;
  const lines = [
    `chain step: ${chain.finishedAt ? 'finished' : show(chain.step)}`,
    `chain started: ${show(chain.startedAt)}  finished: ${show(chain.finishedAt)}`,
    `failed attempts: ${chain.failures}  last failure: ${show(chain.lastFailureAt)}`,
    `paused: ${status.paused}  lease held: ${status.leaseHeld}`,
  ];
  for (const name of SOURCE_COLLECTIONS) {
    const entry = collections[name];
    lines.push(
      `${name}: ${show(entry.status)}  processed ${entry.processed} of about ${show(entry.total)}` +
        `  skipped ${entry.skipped}  analysis failures ${entry.analysisFailures}` +
        `  rate ${entry.rate === null ? '-' : `${Math.round(entry.rate)}/s`}` +
        `  estimated finish ${show(entry.estimatedFinish)}`,
    );
  }
  lines.push(
    `verify: ${show(verification?.status)}  reason ${show(verification?.reason)}` +
      `  mismatched users ${show(verification?.mismatchedUsers)}` +
      `  missing ${show(verification?.missing)}  orphans ${show(verification?.orphans)}` +
      `  changed since backfill ${show(verification?.changedSinceBackfill)}` +
      `  passed at ${show(verification?.passedAt)}`,
    `pending requests: ${status.pendingRequests.join(', ') || '-'}`,
    `distinct tenantId values: ${status.tenants === null ? 'read timed out' : status.tenants.join(', ') || '-'}`,
  );
  return lines;
}

/**
 * The whole of `config/search-job.js` past its wiring. Answers an exit code. `status` only
 * reads; the others write one `jobRequest:<id>` for the lease holder, and never run a job here.
 */
export async function runSearchJobCommand({
  argv,
  methods,
  print,
  now = Date.now,
  randomId = randomUUID,
}: {
  argv: readonly string[];
  methods: SearchScriptMethods;
  print(line: string): void;
  now?: () => number;
  randomId?: () => string;
}): Promise<number> {
  const [command] = argv;
  if (command === 'status') {
    formatSearchJobStatus(await readSearchJobStatus(methods, now())).forEach(print);
    return 0;
  }
  if (!REQUEST_COMMANDS.includes(command as (typeof REQUEST_COMMANDS)[number])) {
    print(USAGE);
    return 2;
  }
  /* Without this the write would create the collection on a tenant with search data off. */
  if (!(await methods.searchStateExists())) {
    print(
      'Search data is not on here: set search.data to true and restart first. Nothing written.',
    );
    return 1;
  }
  const id = randomId();
  await methods.writeSearchState(`jobRequest:${id}`, {
    job: command,
    requestedAt: new Date(now()),
  });
  print(`Requested ${command} (${id}). The lease holder picks it up on its next heartbeat.`);
  return 0;
}
