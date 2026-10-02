import JSZip from 'jszip';
import { convertMetafileToSvg } from 'emf-converter';
import { extractPptxMetafileSvgs, metafileKey, METAFILE_KEY_JS } from './metafiles';

/** Minimal valid little-endian EMF: header, brush, select, rectangle, EOF. */
function buildEmf(): Buffer {
  const parts: Buffer[] = [];
  const rec = (type: number, size: number, ...ints: number[]): Buffer => {
    const b = Buffer.alloc(size);
    b.writeUInt32LE(type, 0);
    b.writeUInt32LE(size, 4);
    ints.forEach((v, i) => b.writeInt32LE(v | 0, 8 + i * 4));
    return b;
  };
  const header = rec(
    1,
    108,
    0,
    0,
    99,
    49, // bounds
    0,
    0,
    2645,
    1322, // frame
    0x464d4520, // signature
    0x10000, // version
    0, // bytes (patched below)
    5, // records
    2, // handles (u32 + reserved u16 packed)
    0, // nDescription
    0, // offDescription
    0, // nPalEntries
    1920,
    1080, // device
    508,
    286, // millimeters
  );
  parts.push(header);
  parts.push(rec(39, 24, 1, 0, 0x00ff0000, 0));
  parts.push(rec(37, 12, 1));
  parts.push(rec(43, 24, 0, 0, 99, 49));
  parts.push(rec(14, 20, 0, 16, 20));
  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length, 48);
  return out;
}

const buildZip = async (files: Record<string, Buffer | string>): Promise<Buffer> => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) {
    zip.file(name, data);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
};

describe('metafiles', () => {
  const emf = buildEmf();

  test('fixture converts with emf-converter', async () => {
    const ab = emf.buffer.slice(emf.byteOffset, emf.byteOffset + emf.byteLength);
    const svg = await convertMetafileToSvg(ab as ArrayBuffer, { idPrefix: 'x-' });
    expect(svg).toContain('<svg');
  });

  test('extracts only convertible emf/wmf entries, keyed by base64 hash', async () => {
    const pptx = await buildZip({
      'ppt/media/image1.emf': emf,
      'ppt/media/image2.png': Buffer.from([1, 2, 3]),
      'ppt/media/logo.emf': emf,
      'ppt/media/image3.emf': Buffer.from('garbage bytes that are not an emf'),
    });
    const map = await extractPptxMetafileSvgs(pptx);
    expect(Object.keys(map)).toEqual([metafileKey(emf.toString('base64'))]);
    const value = Object.values(map)[0];
    expect(value.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(
      Buffer.from(value.slice('data:image/svg+xml;base64,'.length), 'base64').toString(),
    ).toContain('<svg');
  });

  test('resolves {} for a non-zip buffer', async () => {
    await expect(extractPptxMetafileSvgs(Buffer.from('not a zip'))).resolves.toEqual({});
  });

  test('stops converting once the time budget is spent', async () => {
    const blue = Buffer.from(emf);
    blue.writeInt32LE(0x000000ff, 108 + 16);
    const pptx = await buildZip({ 'ppt/media/image1.emf': emf, 'ppt/media/image2.emf': blue });
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(10_000);
    try {
      const map = await extractPptxMetafileSvgs(pptx);
      expect(Object.keys(map)).toEqual([metafileKey(emf.toString('base64'))]);
    } finally {
      now.mockRestore();
    }
  });

  test('METAFILE_KEY_JS matches metafileKey', () => {
    const fn = new Function('return (' + METAFILE_KEY_JS + ')')() as (s: string) => string;
    for (const s of ['', 'abc', Buffer.alloc(52500, 7).toString('base64')]) {
      expect(fn(s)).toBe(metafileKey(s));
    }
  });
});
