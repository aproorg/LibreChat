import { randomUUID } from 'node:crypto';
import type { SearchMethods, SearchSourceCollection } from '@librechat/data-schemas';
import {
  BACKFILL_KEYS,
  CHAIN_KEY,
  JOB_STATE_READ,
  LEASE_KEY,
  RECONCILE_KEY,
  SOURCE_COLLECTIONS,
  STREAM_KEY,
  VERIFICATION_KEY,
  VOCAB_KEY,
} from './control';

export type SearchScriptMethods = Pick<
  SearchMethods,
  | 'readSearchState'
  | 'writeSearchState'
  | 'searchStateExists'
  | 'listSearchJobRequests'
  | 'readSearchSourceTenants'
>;

const REQUEST_COMMANDS = ['backfill', 'pause', 'resume', 'reconcile', 'verify'] as const;
const USAGE = 'Usage: search-job <status|backfill|pause|resume|reconcile|verify>';
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
    /** An error class and driver code, never its message. */
    lastFailureCode: string | null;
  };
  paused: boolean;
  collections: Record<SearchSourceCollection, SearchCollectionStatus>;
  verification: Record<string, unknown> | null;
  wordList: Record<string, unknown> | null;
  reconcile: Record<string, unknown> | null;
  /** When the sync writer last saved its position, or `null` if no writer has run. */
  syncSavedAt: Date | null;
  gapAt: Date | null;
  leaseHeld: boolean;
  pendingRequests: string[];
  /**
   * Read for the check before a backfill. `null` while a chain runs, because this is polled
   * then and each read walks both source collections, or when the read fails, so that a slow
   * `distinct` cannot hide progress.
   */
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
  const chain = await read(CHAIN_KEY);
  const running = chain != null && chain.finishedAt == null;
  const [
    messages,
    conversations,
    verification,
    wordList,
    reconcile,
    stream,
    lease,
    requests,
    tenants,
  ] = await Promise.all([
    read(BACKFILL_KEYS.messages),
    read(BACKFILL_KEYS.conversations),
    read(VERIFICATION_KEY),
    read(VOCAB_KEY),
    read(RECONCILE_KEY),
    read(STREAM_KEY),
    read(LEASE_KEY),
    methods.listSearchJobRequests(),
    running ? null : methods.readSearchSourceTenants().catch(() => null),
  ]);
  return {
    chain: {
      step: typeof chain?.step === 'string' ? chain.step : null,
      startedAt: dateOf(chain?.startedAt),
      finishedAt: dateOf(chain?.finishedAt),
      failures: numberOf(chain?.failures) ?? 0,
      lastFailureAt: dateOf(chain?.lastFailureAt),
      lastFailureCode: typeof chain?.lastFailureCode === 'string' ? chain.lastFailureCode : null,
    },
    paused: messages?.pause === true,
    collections: {
      messages: collectionStatus(messages, now),
      conversations: collectionStatus(conversations, now),
    },
    verification,
    wordList,
    reconcile,
    syncSavedAt: dateOf(stream?.savedAt),
    gapAt: dateOf(stream?.gapAt),
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
  const { chain, collections, verification, wordList, reconcile } = status;
  const lines = [
    `chain step: ${chain.finishedAt ? 'finished' : show(chain.step)}`,
    `chain started: ${show(chain.startedAt)}  finished: ${show(chain.finishedAt)}`,
    `failed attempts: ${chain.failures}  last failure: ${show(chain.lastFailureAt)} ${show(chain.lastFailureCode)}`,
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
  const missingIds = Array.isArray(verification?.missingIds) ? verification.missingIds : [];
  lines.push(
    `word list: ${show(wordList?.status)}  phase ${show(wordList?.phase)}  walked ${show(wordList?.walked)}  last update ${show(wordList?.walkedAt)}`,
    `sync: last saved ${show(status.syncSavedAt)}  last gap ${show(status.gapAt)}`,
    `reconcile: ${show(reconcile?.status)}  pass ${show(reconcile?.pass)}  phase ${show(reconcile?.phase)}` +
      `  missing ${show(reconcile?.missing)}  orphans ${show(reconcile?.orphans)}  stale ${show(reconcile?.stale)}` +
      `  of ${show(reconcile?.of)}  repaired ${show(reconcile?.repaired)}  finished ${show(reconcile?.finishedAt)}`,
    `verify: ${show(verification?.status)}${verification?.running === true ? ' (walk running)' : ''}  checked ${show(verification?.checked)}  reason ${show(verification?.reason)}` +
      `  mismatched users ${show(verification?.mismatchedUsers)}` +
      `  missing ${show(verification?.missing)}  orphans ${show(verification?.orphans)}` +
      `  changed since backfill ${show(verification?.changedSinceBackfill)}` +
      `  analysis failures ${show(verification?.analysisFailures)}` +
      `  other analyzer version ${show(verification?.otherVersion)}` +
      `  failed attempts ${show(verification?.failures)}` +
      `  round ${show(verification?.rounds)}  mode ${show(verification?.mode)}` +
      `  last passed ${show(verification?.passedAt)}`,
    ...(missingIds.length > 0
      ? [`sample of source IDs with no record: ${missingIds.join(', ')}`]
      : []),
    `pending requests: ${status.pendingRequests.join(', ') || '-'}`,
    `distinct tenantId values: ${status.tenants === null ? 'not read' : status.tenants.join(', ') || '-'}`,
    `next: ${nextAction(status)}`,
  );
  return lines;
}

/** One thing to do, so the output never leaves the operator guessing. */
function nextAction(status: SearchJobStatus): string {
  const { chain, paused, leaseHeld, verification, pendingRequests } = status;
  const running = chain.step !== null && chain.finishedAt === null;
  if (chain.step === null && pendingRequests.length === 0) {
    return 'run backfill to start.';
  }
  if (paused) {
    return 'run resume to carry on.';
  }
  if ((running || pendingRequests.length > 0) && !leaseHeld) {
    return 'no process holds the lease: check the server is up and search.data is true, and look for "[search] Language pack failed" in its logs.';
  }
  if (running && chain.failures > 0) {
    return 'it retries by itself. Look for "[search] Job failed" in the server logs.';
  }
  if (running) {
    return `nothing. The chain is working on ${chain.step}.`;
  }
  if (pendingRequests.length > 0) {
    return 'nothing. The lease holder picks up the request on its next heartbeat.';
  }
  if (verification?.status === 'failed' && verification.reason === 'analysis_failed') {
    return 'a language pack threw on some rows: fix the pack, then run backfill, which re-reads every row.';
  }
  if (verification?.status === 'failed' && verification.gaveUp !== true && status.syncSavedAt) {
    return 'nothing yet. The mismatch loop reconciles and verifies again, up to three rounds.';
  }
  if (verification?.status === 'failed' && status.syncSavedAt) {
    return 'three rounds failed: read the sample IDs, fix the cause, then run reconcile and verify.';
  }
  if (verification?.status === 'failed') {
    return 'run backfill to fill the gaps, then check again. Rows a language pack threw on need a fixed pack first.';
  }
  return 'nothing. The chain has finished.';
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
      'Nothing written: the search collections do not exist. Either search.data is off, or the ' +
        'language packs failed to load: set search.data to true, restart, and look for ' +
        '"[search] Language pack failed" in the server logs.',
    );
    return 1;
  }
  const [chain, lease] = await Promise.all([
    methods.readSearchState(CHAIN_KEY, JOB_STATE_READ),
    methods.readSearchState(LEASE_KEY, JOB_STATE_READ),
  ]);
  if (command === 'backfill' && chain != null && chain.finishedAt == null) {
    print(
      `Nothing written: a chain is already at step ${show(chain.step)}. Use status to watch it.`,
    );
    return 0;
  }
  const id = randomId();
  await methods.writeSearchState(`jobRequest:${id}`, {
    job: command,
    requestedAt: new Date(now()),
  });
  print(`Requested ${command} (${id}). The lease holder picks it up on its next heartbeat.`);
  if ((dateOf(lease?.leaseUntil)?.getTime() ?? 0) <= now()) {
    print('No process holds the lease right now, so this waits until one does. Check the server.');
  }
  return 0;
}
