/** Writes the fold table's binary format from entries, so tests need no real table. */
export function buildFoldTableBytes(entries: ReadonlyArray<readonly [string, string[]]>): Buffer {
  const sorted = [...entries].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const records = sorted.map(([form, lemmas]) => Buffer.from(`${form}\t${lemmas.join(',')}\n`));
  const offsets = new Uint32Array(records.length);
  let position = 0;
  records.forEach((record, i) => {
    offsets[i] = position;
    position += record.length;
  });
  const head = Buffer.alloc(4);
  head.writeUInt32LE(records.length, 0);
  return Buffer.concat([head, Buffer.from(offsets.buffer), ...records]);
}
