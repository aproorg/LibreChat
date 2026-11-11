import { readFile } from 'node:fs/promises';

const SEPARATOR = 0x09;
const NEWLINE = 0x0a;

/**
 * Diacritic-free form to diacritic-free lemmas, as one sorted Buffer read by binary
 * search, so it costs off-heap bytes and no garbage collection. The table itself is
 * built outside this repository and delivered in `languageDataDir`.
 */
export class FoldTable {
  private constructor(
    private readonly buffer: Buffer,
    private readonly offsets: Uint32Array,
  ) {}

  static fromBytes(raw: Buffer): FoldTable {
    if (raw.length < 4) {
      throw new RangeError('The fold table is truncated');
    }
    const count = raw.readUInt32LE(0);
    const recordsStart = 4 + count * 4;
    if (raw.length < recordsStart) {
      throw new RangeError('The fold table is truncated');
    }
    const offsets = new Uint32Array(
      raw.buffer.slice(raw.byteOffset + 4, raw.byteOffset + recordsStart),
    );
    return new FoldTable(raw.subarray(recordsStart), offsets);
  }

  static async load(path: string): Promise<FoldTable> {
    return FoldTable.fromBytes(await readFile(path));
  }

  /** Folded lemmas of a folded form, empty when the form is unknown. */
  lookup(folded: string): string[] {
    const { buffer, offsets } = this;
    const key = Buffer.from(folded);
    let low = 0;
    let high = offsets.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const start = offsets[middle];
      const keyEnd = buffer.indexOf(SEPARATOR, start);
      if (keyEnd < 0) {
        return [];
      }
      const order = key.compare(buffer, start, keyEnd);
      if (order === 0) {
        const lineEnd = buffer.indexOf(NEWLINE, keyEnd + 1);
        return lineEnd < 0 ? [] : buffer.toString('utf8', keyEnd + 1, lineEnd).split(',');
      }
      if (order < 0) {
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    return [];
  }

  size(): number {
    return this.offsets.length;
  }

  bytes(): Buffer {
    return this.buffer;
  }
}
