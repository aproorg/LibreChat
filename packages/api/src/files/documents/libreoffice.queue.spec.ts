import { convertOfficeToPdf, LibreOfficeConversionError } from './libreoffice';

/* Fake `soffice`: `--version` succeeds; a conversion writes `input.pdf`
 * into `--outdir` after a short delay, or exits 1 when `failNext` is set.
 * Tracks how many conversions overlap. */
const mockState = { active: 0, maxActive: 0, failNext: false };

jest.mock('child_process', () => {
  const { EventEmitter } = jest.requireActual('events');
  const { writeFileSync } = jest.requireActual('fs');
  const { join } = jest.requireActual('path');
  return {
    spawn: jest.fn((_binary: string, args: string[]) => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: jest.fn(),
      });
      if (args[0] === '--version') {
        setImmediate(() => {
          proc.stdout.emit('data', 'LibreOffice 25.8\n');
          proc.emit('exit', 0);
        });
        return proc;
      }
      const fail = mockState.failNext;
      mockState.failNext = false;
      mockState.active += 1;
      mockState.maxActive = Math.max(mockState.maxActive, mockState.active);
      const outdir = args[args.indexOf('--outdir') + 1];
      setTimeout(() => {
        if (!fail) {
          writeFileSync(join(outdir, 'input.pdf'), '%PDF-1.4');
        }
        mockState.active -= 1;
        proc.emit('exit', fail ? 1 : 0);
      }, 20);
      return proc;
    }),
  };
});

describe('convertOfficeToPdf queue', () => {
  beforeEach(() => {
    mockState.active = 0;
    mockState.maxActive = 0;
    mockState.failNext = false;
  });

  it('runs one soffice conversion at a time', async () => {
    const pdfs = await Promise.all(
      [1, 2, 3].map(() => convertOfficeToPdf(Buffer.from('deck'), 'pptx')),
    );
    expect(pdfs.map((pdf) => pdf.toString())).toEqual(['%PDF-1.4', '%PDF-1.4', '%PDF-1.4']);
    expect(mockState.maxActive).toBe(1);
  });

  it('keeps converting after a failed conversion', async () => {
    mockState.failNext = true;
    const results = await Promise.allSettled([
      convertOfficeToPdf(Buffer.from('broken'), 'pptx'),
      convertOfficeToPdf(Buffer.from('deck'), 'pptx'),
    ]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed?.reason).toBeInstanceOf(LibreOfficeConversionError);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
