import type { CellObject, WorkBook } from 'xlsx';

/** The subset of SheetJS `SSF` used here; the package types it as `any`. */
interface SpreadsheetFormatter {
  is_date(fmt: string): boolean;
  format(fmt: string, value: number, options?: { date1904?: boolean }): string;
}

/**
 * Quote every `.` in a number format so SheetJS treats it as a literal separator.
 * Skips dots inside `"..."` literals, backslash-escaped dots and `.0` fractional seconds.
 */
function quoteFormatDots(fmt: string): string {
  return fmt.replace(/"[^"]*"|\\.|\.(?!0)/g, (match) => (match === '.' ? '"."' : match));
}

/**
 * SheetJS reads `.` in a number format as the start of fractional seconds, so date formats such
 * as `dd.mm.yyyy` throw while formatting and the cell is left with only its raw serial number.
 * Renders those cells again with the dots quoted; every other cell keeps what SheetJS produced.
 * The workbook must have been read with `cellNF: true` so the format is available on `cell.z`.
 */
export function fillUnformattedDates(workbook: WorkBook, ssf: SpreadsheetFormatter): void {
  const date1904 = workbook.Workbook?.WBProps?.date1904 === true;
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    for (const address in worksheet) {
      if (address.startsWith('!')) {
        continue;
      }
      const cell = worksheet[address] as CellObject;
      if (cell.t !== 'n' || cell.w != null || typeof cell.v !== 'number') {
        continue;
      }
      if (typeof cell.z !== 'string' || !ssf.is_date(cell.z)) {
        continue;
      }
      try {
        cell.w = ssf.format(quoteFormatDots(cell.z), cell.v, { date1904 });
      } catch {
        /* Keep the raw value when the format still cannot be rendered */
      }
    }
  }
}
