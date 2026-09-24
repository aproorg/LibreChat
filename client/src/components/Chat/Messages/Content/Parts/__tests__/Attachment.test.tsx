import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileSources } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import Attachment from '../Attachment';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
  useAttachmentPreviewSync: () => ({ status: 'ready', previewError: undefined, isPolling: false }),
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

const mockHandleDownload = jest.fn();
jest.mock('../LogLink', () => ({
  useAttachmentLink: () => ({ handleDownload: mockHandleDownload }),
  // Mirrors the real predicate (LogLink.tsx) — kept in sync by hand like the
  // sibling mock in Artifacts/__tests__/DownloadArtifact.test.tsx.
  isLocallyStoredSource: (source?: string) =>
    ['local', 'firebase', 's3', 'cloudfront', 'azure_blob', 'text'].includes(source ?? ''),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file, onClick }: { file: { filename?: string }; onClick?: () => void }) => (
    <button type="button" data-testid="file-container" onClick={onClick}>
      {file.filename ?? ''}
    </button>
  ),
}));

jest.mock('~/components/Chat/Input/Files/FilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="file-preview" />,
}));

jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: ({ altText }: { altText?: string }) => <img alt={altText ?? ''} data-testid="image" />,
}));

// Dialog internals (data fetching, iframe rendering) are FilePreviewDialog's
// own concern (covered by its sibling tests) — stand in with a minimal probe
// so this suite only asserts on Attachment's routing decision.
jest.mock('../../FilePreviewDialog', () => ({
  __esModule: true,
  default: ({ open, fileName }: { open: boolean; fileName: string }) =>
    open ? <div data-testid="file-preview-dialog">{fileName}</div> : null,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getFileType: () => ({ paths: [], color: '', title: 'Artifact' }),
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isArtifactRoute: () => false,
  // Real impl (downloadFile.ts) — `preview.ts`'s `isCodeOutputFallback`
  // needs this to exclude absolute http(s) targets.
  isHttpDownloadTarget: (target?: string | null) => /^https?:\/\//i.test(target ?? ''),
}));

const baseAttachment = (overrides: Partial<TAttachment> = {}): TAttachment =>
  ({
    filename: 'report.pdf',
    filepath: '/files/file-1',
    type: 'application/pdf',
    ...overrides,
  }) as TAttachment;

describe('FileAttachment preview routing', () => {
  beforeEach(() => {
    mockHandleDownload.mockReset();
  });

  it('opens the preview dialog for a persisted (owner-fetchable) PDF attachment', () => {
    // Real shape for a normally-persisted code-interpreter output
    // (api/server/services/Files/Code/process.js): a real file_id + a
    // storage source, fetchable through the owner ACL route.
    const persisted = baseAttachment({
      file_id: 'file-1',
      source: FileSources.local,
    } as Partial<TAttachment>);
    render(<Attachment attachment={persisted} />);

    expect(screen.queryByTestId('file-preview-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-container'));

    expect(screen.getByTestId('file-preview-dialog')).toHaveTextContent('report.pdf');
    expect(mockHandleDownload).not.toHaveBeenCalled();
  });

  it('opens the preview dialog for a download-fallback PDF (no file_id/source)', () => {
    // Real shape for `createDownloadFallback` (process.js): no file_id, no
    // source — only filename + a code-output filepath.
    const fallback = baseAttachment({
      filepath: '/api/files/code/download/session-1/output-1',
    });
    render(<Attachment attachment={fallback} />);

    expect(screen.queryByTestId('file-preview-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-container'));

    expect(screen.getByTestId('file-preview-dialog')).toHaveTextContent('report.pdf');
    expect(mockHandleDownload).not.toHaveBeenCalled();
  });

  it('falls back to download for a non-previewable download-fallback attachment (zip)', () => {
    const zipType: string = 'application/zip';
    const zip = baseAttachment({
      filename: 'archive.zip',
      filepath: '/api/files/code/download/session-1/output-2',
      type: zipType,
    } as Partial<TAttachment>);
    render(<Attachment attachment={zip} />);

    fireEvent.click(screen.getByTestId('file-container'));

    expect(mockHandleDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('file-preview-dialog')).not.toBeInTheDocument();
  });

  it('falls back to download for a previewable type behind an absolute http(s) filepath', () => {
    // Neither owner-fetchable (no file_id) nor a code-output fallback (not a
    // relative code-output path) — the blob-fetch dialog has no route to
    // its bytes, so it must keep downloading like `useAttachmentLink` does.
    const external = baseAttachment({
      filepath: 'https://cdn.example.com/uploads/report.pdf',
    });
    render(<Attachment attachment={external} />);

    fireEvent.click(screen.getByTestId('file-container'));

    expect(mockHandleDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('file-preview-dialog')).not.toBeInTheDocument();
  });
});
