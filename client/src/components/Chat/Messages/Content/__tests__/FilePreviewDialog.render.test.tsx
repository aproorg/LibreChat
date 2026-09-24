import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import type { MutableSnapshot } from 'recoil';
import { FileSources } from 'librechat-data-provider';
import FilePreviewDialog from '../FilePreviewDialog';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => ({}),
}));

const mockDownloadOwned = jest.fn();
const mockPreviewOwned = jest.fn();
const mockDownloadShared = jest.fn();
const mockPreviewShared = jest.fn();
const mockDownloadCodeOutput = jest.fn();
const mockPreviewCodeOutput = jest.fn();
const mockRevokeDownloadURL = jest.fn();

jest.mock('~/data-provider', () => ({
  useFileDownload: (
    _userId: string | undefined,
    _fileId: string | undefined,
    options: { purpose?: string } = {},
  ) => ({ refetch: options.purpose === 'preview' ? mockPreviewOwned : mockDownloadOwned }),
  useSharedFileDownload: (
    _shareId: string | undefined,
    _fileId: string | undefined,
    purpose: 'download' | 'preview' = 'download',
  ) => ({ refetch: purpose === 'preview' ? mockPreviewShared : mockDownloadShared }),
  useCodeOutputDownload: (_url: string, purpose: 'download' | 'preview' = 'download') => ({
    refetch: purpose === 'preview' ? mockPreviewCodeOutput : mockDownloadCodeOutput,
  }),
  revokeDownloadURL: (...args: unknown[]) => mockRevokeDownloadURL(...args),
}));

jest.mock('~/utils', () => ({
  getDownloadFilename: (filename: string, fileId?: string, source?: string) => {
    const resolved = filename || fileId || 'download';
    return source === 'text' && !resolved.toLowerCase().endsWith('.txt')
      ? `${resolved}.txt`
      : resolved;
  },
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  sortPagesByRelevance: (pages: number[]) => pages,
  triggerDownload: jest.fn(),
  // Real impl (downloadFile.ts) — `preview.ts`'s `isCodeOutputFallback`
  // needs this to exclude absolute http(s) targets.
  isHttpDownloadTarget: (target?: string | null) => /^https?:\/\//i.test(target ?? ''),
}));

type DialogProps = React.ComponentProps<typeof FilePreviewDialog>;

const renderDialog = (props: Partial<DialogProps> = {}) => {
  const initializeState = (snap: MutableSnapshot) => {
    snap.set(store.user, { id: 'user-1' } as never);
  };
  return render(
    <RecoilRoot initializeState={initializeState}>
      <FilePreviewDialog open onOpenChange={jest.fn()} fileName="report.pdf" {...props} />
    </RecoilRoot>,
  );
};

describe('FilePreviewDialog code-output routing', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    jest.clearAllMocks();
    URL.createObjectURL = jest.fn(() => 'blob:preview-object-url');
    URL.revokeObjectURL = jest.fn();
    global.fetch = jest.fn(() =>
      Promise.resolve({ blob: () => Promise.resolve(new Blob(['pdf-bytes'])) }),
    ) as unknown as typeof fetch;
  });

  // Restored in `afterAll`, not `afterEach`: RTL's automatic per-test
  // cleanup (registered outside this `describe`, so it unmounts *after*
  // this file's own `afterEach` hooks run) fires the dialog's unmount
  // effect, which calls `URL.revokeObjectURL` — restoring the real jsdom
  // implementation too early throws before that cleanup completes.
  afterAll(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('fetches a download-fallback PDF (no file_id/source) through the code-output route, preview and download on separate queries', async () => {
    // Real shape for `createDownloadFallback` (api/server/services/Files/
    // Code/process.js): no file_id, no source — only a code-output filepath.
    mockPreviewCodeOutput.mockResolvedValue({ data: 'blob:code-preview-url' });
    mockDownloadCodeOutput.mockResolvedValue({ data: 'blob:code-download-url' });

    renderDialog({
      filePath: '/api/files/code/download/session-1/output-1',
      fileType: 'application/pdf',
    });

    await waitFor(() => expect(mockPreviewCodeOutput).toHaveBeenCalledTimes(1));
    expect(mockDownloadCodeOutput).not.toHaveBeenCalled();
    expect(mockPreviewOwned).not.toHaveBeenCalled();
    expect(mockDownloadOwned).not.toHaveBeenCalled();

    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());

    const downloadButton = await screen.findByRole('button', { name: /download.*report\.pdf/i });
    fireEvent.click(downloadButton);

    // Download uses its own query — must not replay/interfere with the
    // already-resolved preview fetch (the bug this test guards against).
    await waitFor(() => expect(mockDownloadCodeOutput).toHaveBeenCalledTimes(1));
    expect(mockPreviewCodeOutput).toHaveBeenCalledTimes(1);
  });

  it('fetches an owner-fetchable PDF (file_id + locally-stored source) through the owned route, not code-output', async () => {
    mockPreviewOwned.mockResolvedValue({ data: 'blob:owned-preview-url' });

    renderDialog({
      fileId: 'file-1',
      filePath: '/files/file-1',
      fileType: 'application/pdf',
      fileSource: FileSources.local,
    });

    await waitFor(() => expect(mockPreviewOwned).toHaveBeenCalledTimes(1));
    expect(mockPreviewCodeOutput).not.toHaveBeenCalled();
    expect(mockDownloadCodeOutput).not.toHaveBeenCalled();
  });

  it('does not treat an absolute http(s) filepath as a code-output fallback (no fetchable route, download-only)', async () => {
    renderDialog({
      filePath: 'https://cdn.example.com/uploads/report.pdf',
      fileType: 'application/pdf',
    });

    // No file_id (owner route) and not a relative code-output path — nothing
    // to fetch: no preview call fires, no download action is offered from
    // inside the dialog (Attachment.tsx wouldn't have opened it for this
    // shape either — `canPreview` gates on the same fetchability check).
    await waitFor(() => expect(screen.queryByText('com_ui_loading')).not.toBeInTheDocument());
    expect(mockPreviewCodeOutput).not.toHaveBeenCalled();
    expect(mockPreviewOwned).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /download.*report\.pdf/i }),
    ).not.toBeInTheDocument();
  });
});
