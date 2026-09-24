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
}));

const codeAttachment = (overrides: Partial<TAttachment> = {}): TAttachment =>
  ({
    file_id: 'file-1',
    filename: 'report.pdf',
    filepath: '/api/files/code/download/session-1/file-1',
    type: 'application/pdf',
    source: FileSources.execute_code,
    ...overrides,
  }) as TAttachment;

describe('FileAttachment preview routing', () => {
  beforeEach(() => {
    mockHandleDownload.mockReset();
  });

  it('opens the preview dialog for a previewable execute_code attachment (PDF) instead of downloading', () => {
    render(<Attachment attachment={codeAttachment()} />);

    expect(screen.queryByTestId('file-preview-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-container'));

    expect(screen.getByTestId('file-preview-dialog')).toHaveTextContent('report.pdf');
    expect(mockHandleDownload).not.toHaveBeenCalled();
  });

  it('falls back to download for a non-previewable execute_code attachment (zip)', () => {
    const zipType: string = 'application/zip';
    const zip = codeAttachment({
      file_id: 'file-2',
      filename: 'archive.zip',
      filepath: '/api/files/code/download/session-1/file-2',
      type: zipType,
    } as Partial<TAttachment>);
    render(<Attachment attachment={zip} />);

    fireEvent.click(screen.getByTestId('file-container'));

    expect(mockHandleDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('file-preview-dialog')).not.toBeInTheDocument();
  });
});
