import { FileSources } from 'librechat-data-provider';
import { isHttpDownloadTarget } from '~/utils';
import { isLocallyStoredSource } from './Parts/LogLink';

type PreviewKind = 'pdf' | 'text' | false;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'csv',
  'json',
  'xml',
  'yaml',
  'yml',
  'html',
  'css',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'rb',
  'java',
  'c',
  'cpp',
  'h',
  'go',
  'rs',
  'sh',
  'sql',
  'log',
]);

export function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function shouldUseSharedFileDownload(shareId?: string, fileId?: string): boolean {
  return !!shareId && !!fileId;
}

function getPreviewKindByMime(mime?: string): PreviewKind {
  if (!mime) {
    return false;
  }
  if (mime.includes('pdf')) {
    return 'pdf';
  }
  if (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('javascript') ||
    mime.includes('typescript') ||
    mime.includes('yaml') ||
    mime.includes('csv')
  ) {
    return 'text';
  }
  return false;
}

function getPreviewKindByExtension(filename: string): PreviewKind {
  const extension = getFileExtension(filename);
  if (extension === 'pdf') {
    return 'pdf';
  }
  return TEXT_EXTENSIONS.has(extension) ? 'text' : false;
}

export function getPreviewKind(
  fileName: string,
  fileType?: string,
  fileSource?: string,
): PreviewKind {
  if (fileSource === FileSources.text) {
    return 'text';
  }
  return getPreviewKindByMime(fileType) || getPreviewKindByExtension(fileName);
}

/**
 * True when a file's bytes must be fetched through the session-scoped
 * code-output route (`/api/files/code/download/:session_id/:file_id`)
 * rather than the owner-ACL `/api/files/download/:userId/:file_id` route.
 *
 * Persisted code-interpreter outputs get a real `file_id` + a storage
 * `source` and are owner-fetchable like any other file. Outputs that fell
 * back to a bare download URL (`createDownloadFallback` in
 * `api/server/services/Files/Code/process.js`) have neither — only a
 * `filepath` pointing at the code-output route — so they need this path
 * instead (mirrors `useAttachmentLink`'s routing in `Parts/LogLink.tsx`).
 * Absolute http(s) targets (external storage) are excluded: those were
 * never fetchable through either authorized-blob route and download
 * directly instead.
 */
export function isCodeOutputFallback(
  filePath?: string,
  fileId?: string,
  fileSource?: string,
): boolean {
  if (!filePath || isHttpDownloadTarget(filePath)) {
    return false;
  }
  return !(fileId && isLocallyStoredSource(fileSource));
}
