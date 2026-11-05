/** Part of the analyzer version. Raise it when the fold rule changes, because that changes tokens. */
export const FOLD_RULE_VERSION = 1;

/** Letters with no decomposition, which a bare NFD strip would leave untouched. */
const SPECIAL = new Map<string, string>([
  ['þ', 'th'],
  ['ð', 'd'],
  ['æ', 'ae'],
  ['ø', 'o'],
  ['œ', 'oe'],
  ['ß', 'ss'],
  ['đ', 'd'],
  ['ł', 'l'],
]);

/** The diacritic-insensitive key every token is stored and looked up under. */
export function fold(input: string): string {
  let out = '';
  for (const ch of input.normalize('NFC').toLowerCase()) {
    out += SPECIAL.get(ch) ?? ch;
  }
  return out.normalize('NFD').replace(/\p{M}+/gu, '');
}
