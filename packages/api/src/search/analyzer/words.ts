export const MAX_WORD_LENGTH = 48;

const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Lowercase words of one text. Normalizes first, so decomposed text does not split at a
 * mark. Marks alone are no word: an emoji's variation selector would fold to an empty token.
 */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const [word] of text.normalize('NFC').matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    if (word.length <= MAX_WORD_LENGTH && HAS_LETTER_OR_NUMBER.test(word)) {
      out.push(word.toLowerCase());
    }
  }
  return out;
}
