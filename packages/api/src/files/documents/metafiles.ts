import yauzl from 'yauzl';
import { logger } from '@librechat/data-schemas';
import { convertMetafileToSvg } from 'emf-converter';
import { megabyte } from 'librechat-data-provider';

/* Browsers cannot decode EMF/WMF, so pptx-preview's `<img>` for them is
 * broken. We convert on the server and let the iframe swap them in. */
const METAFILE_NAME = /^ppt\/media\/image[^/]*\.(emf|wmf)$/i;
const MAX_METAFILES = 64;
const MAX_METAFILE_BYTES = 5 * megabyte;
const MAX_SVG_BYTES = 256 * 1024;
const MAX_TOTAL_SVG_BYTES = 384 * 1024;
/* Conversion is synchronous CPU work on the event loop; these bound a hostile
 * deck. Checked between entries, so one entry may overrun the time budget. */
const MAX_TOTAL_METAFILE_BYTES = 8 * megabyte;
const MAX_CONVERT_MS = 3000;

/** FNV-1a 32-bit over UTF-16 code units; must match `METAFILE_KEY_JS`. */
export function metafileKey(base64: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < base64.length; i++) {
    h ^= base64.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16) + ':' + base64.length;
}

/** Same algorithm as `metafileKey`, as ES5 source for the iframe bootstrap. */
export const METAFILE_KEY_JS =
  'function(s){var h=0x811c9dc5;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}return h.toString(16)+":"+s.length}';

function readEntryBuffer(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer | null> {
  return new Promise((resolve) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        return resolve(null);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_METAFILE_BYTES) {
          stream.destroy();
          return resolve(null);
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', () => resolve(null));
    });
  });
}

async function convertToDataUri(bytes: Buffer, index: number): Promise<string | null> {
  try {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const svg = await convertMetafileToSvg(ab as ArrayBuffer, { idPrefix: `lc-mf${index}-` });
    const svgBytes = svg ? Buffer.from(svg, 'utf-8') : null;
    if (!svgBytes || svgBytes.length > MAX_SVG_BYTES) {
      return null;
    }
    return 'data:image/svg+xml;base64,' + svgBytes.toString('base64');
  } catch (err) {
    logger.debug(`[pptx] skipping unconvertible metafile: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Convert the EMF/WMF media of a PPTX to SVG data URIs, keyed by
 * `metafileKey` of the entry's base64 (what pptx-preview puts in `img.src`).
 * Never rejects; unreadable zips and corrupt metafiles yield fewer entries.
 */
export function extractPptxMetafileSvgs(buffer: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        return resolve({});
      }
      const result: Record<string, string> = {};
      let considered = 0;
      let totalSvgBytes = 0;
      let totalMetafileBytes = 0;
      const startedAt = Date.now();
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          zipfile.close();
        } catch {
          /* best-effort, as in extractPptxSlideXml */
        }
        resolve(result);
      };

      zipfile.on('entry', async (entry: yauzl.Entry) => {
        try {
          if (
            !/\/$/.test(entry.fileName) &&
            METAFILE_NAME.test(entry.fileName) &&
            considered < MAX_METAFILES &&
            entry.uncompressedSize <= MAX_METAFILE_BYTES
          ) {
            totalMetafileBytes += entry.uncompressedSize;
            if (
              totalMetafileBytes > MAX_TOTAL_METAFILE_BYTES ||
              Date.now() - startedAt > MAX_CONVERT_MS
            ) {
              return finish();
            }
            const index = considered++;
            const bytes = await readEntryBuffer(zipfile, entry);
            const uri = bytes && (await convertToDataUri(bytes, index));
            if (bytes && uri && totalSvgBytes + uri.length <= MAX_TOTAL_SVG_BYTES) {
              totalSvgBytes += uri.length;
              result[metafileKey(bytes.toString('base64'))] = uri;
            }
          }
        } catch (e) {
          logger.debug(`[pptx] metafile extraction error: ${(e as Error).message}`);
        }
        zipfile.readEntry();
      });
      zipfile.on('end', finish);
      zipfile.on('error', finish);
      zipfile.readEntry();
    });
  });
}
