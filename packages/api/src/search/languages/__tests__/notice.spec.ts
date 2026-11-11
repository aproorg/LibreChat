import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createIsPack, IS_ATTRIBUTION } from '../is';

/** FR-043's verbatim text. */
const CREDIT =
  'The Database of Icelandic Morphology. The Árni Magnússon Institute for Icelandic Studies. Author and editor Kristín Bjarnadóttir.';

describe('the Icelandic data notice', () => {
  const notice = readFileSync(join(__dirname, '../is/NOTICE.md'), 'utf8');

  it('carries the credit verbatim, the URL and the licence', () => {
    expect(notice).toContain(CREDIT);
    expect(notice).toContain('https://bin.arnastofnun.is');
    expect(notice).toContain('CC BY-SA 4.0');
  });

  it('states the changes to the data and gives the derived table its own notice', () => {
    expect(notice).toMatch(/## Changes to the data/);
    expect(notice).toMatch(/## Derived table/);
    expect(notice).toContain('fold-table.bin');
  });

  it('holds the same attribution the pack shows', () => {
    expect(IS_ATTRIBUTION).toEqual({ text: CREDIT, url: 'https://bin.arnastofnun.is' });
    expect(createIsPack({ languageDataDir: '' }).attribution).toEqual(IS_ATTRIBUTION);
  });
});
