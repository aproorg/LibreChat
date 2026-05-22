import type { TFile } from 'librechat-data-provider';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getFiles: jest.fn() },
  };
});

import { FILES_EMBEDDING_POLL_MS, filesEmbeddingRefetchInterval } from '../queries';

const fileWith = (overrides: Partial<TFile>): TFile =>
  ({
    user: 'user-1',
    file_id: 'fid',
    bytes: 0,
    embedded: false,
    filename: 'doc.pdf',
    filepath: 'vectordb',
    object: 'file',
    type: 'application/pdf',
    usage: 0,
    ...overrides,
  }) as TFile;

describe('filesEmbeddingRefetchInterval', () => {
  it('returns false when data is undefined (initial mount before fetch resolves)', () => {
    expect(filesEmbeddingRefetchInterval(undefined)).toBe(false);
  });

  it('returns false on empty arrays', () => {
    expect(filesEmbeddingRefetchInterval([])).toBe(false);
  });

  it('returns false when no file is in flight', () => {
    const data = [
      fileWith({ file_id: 'a', embedStatus: 'ready' }),
      fileWith({ file_id: 'b', embedStatus: 'error' }),
      fileWith({ file_id: 'c' }),
    ];
    expect(filesEmbeddingRefetchInterval(data)).toBe(false);
  });

  it('returns the poll interval when at least one file is in flight', () => {
    const data = [
      fileWith({ file_id: 'a', embedStatus: 'ready' }),
      fileWith({ file_id: 'b', embedStatus: 'embedding' }),
    ];
    expect(filesEmbeddingRefetchInterval(data)).toBe(FILES_EMBEDDING_POLL_MS);
  });

  it('does not poll when select narrowed the data to a non-array (boolean)', () => {
    /* `useGetFiles` is generic over `TData` and consumers may pass a
     * `select` returning `boolean`. The predicate must degrade to `false`
     * rather than throw, since the embedStatus check only makes sense on
     * the raw file list. */
    expect(filesEmbeddingRefetchInterval(true)).toBe(false);
    expect(filesEmbeddingRefetchInterval(false)).toBe(false);
  });
});
