import type { SearchMethods } from '@librechat/data-schemas';
import { ANALYZER_KEY } from '../jobs/control';

/**
 * A database holds one tenant (R-04): the word list and the sync state carry no tenant. So
 * whatever builds records from source rows, the sync writer, backfill and reconcile alike,
 * pins the first `tenantId` it sees and stops at a second, before that tenant's rows are
 * indexed and served.
 */
export class TenantMismatch extends Error {
  constructor() {
    super('tenant_mismatch');
    this.name = 'TenantMismatch';
  }
}

/** The pin after these rows. A row with no `tenantId` is legal and changes nothing. */
export function pinTenant(tenantIds: Iterable<unknown>, pinned: string | null): string | null {
  let pin = pinned;
  for (const tenantId of tenantIds) {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      continue;
    }
    if (pin === null) {
      pin = tenantId;
    } else if (pin !== tenantId) {
      throw new TenantMismatch();
    }
  }
  return pin;
}

/** Checks a batch against the pin and stores a first one. Throws `TenantMismatch`. */
export async function holdTenantPin(
  methods: Pick<SearchMethods, 'writeSearchState'>,
  tenantIds: Iterable<unknown>,
  pinned: string | null,
): Promise<string | null> {
  const pin = pinTenant(tenantIds, pinned);
  if (pin !== pinned) {
    await methods.writeSearchState(ANALYZER_KEY, { tenantId: pin });
  }
  return pin;
}
