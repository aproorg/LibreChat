import _ from 'lodash';

const isUnset = (value: unknown): boolean => value === null || value === undefined;

/**
 * Whether a stored source row belongs in search, over plain fields only, so it
 * works on change events and lean rows. It agrees with the plugin's
 * `buildIndexableQuery` plus `unfinished: { $ne: true }`: "explicit" means the
 * stored temporary flag is present and non-null, and a present exclusion path
 * excludes even when null, as `$exists: false` does.
 */
export function isIndexableSource(
  doc: Record<string, unknown>,
  excludePath?: string,
  now: number = Date.now(),
): boolean {
  if (doc === null || typeof doc !== 'object') {
    return false;
  }
  if (doc.unfinished === true) {
    return false;
  }
  if (excludePath != null && _.get(doc, excludePath) !== undefined) {
    return false;
  }

  const { isTemporary, expiredAt } = doc;
  if (isUnset(isTemporary)) {
    return isUnset(expiredAt);
  }
  if (isTemporary !== false) {
    return false;
  }
  return isUnset(expiredAt) || (expiredAt instanceof Date && expiredAt.getTime() > now);
}
