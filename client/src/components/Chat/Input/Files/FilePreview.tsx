import { Spinner, FileIcon } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { useLocalize } from '~/hooks';
import SourceIcon from './SourceIcon';
import { cn } from '~/utils';

const FilePreview = ({
  file,
  fileType,
  className = '',
}: {
  file?: Partial<ExtendedFile | TFile>;
  fileType: {
    paths: React.FC;
    fill: string;
    title: string;
  };
  className?: string;
}) => {
  const localize = useLocalize();
  const inFlightUpload = typeof file?.['progress'] === 'number' && file?.['progress'] < 1;
  /* `embedStatus === 'embedding'` is the server-side counterpart: the upload
   * is done from the browser's perspective but the RAG ingestion is still in
   * flight. Persisting the spinner here is what makes the indexing wait
   * survive a browser refresh — the persisted MongoFile drives the icon. */
  const indexing = (file as Partial<TFile> | undefined)?.embedStatus === 'embedding';
  const showSpinner = inFlightUpload || indexing;
  const spinnerTitle = indexing ? localize('com_ui_upload_indexing') : undefined;
  return (
    <div
      className={cn('relative size-10 shrink-0 overflow-hidden rounded-xl', className)}
      title={spinnerTitle}
    >
      <FileIcon file={file} fileType={fileType} />
      <SourceIcon source={file?.source} isCodeFile={!!file?.['metadata']?.fileIdentifier} />
      {showSpinner && (
        <Spinner
          bgOpacity={0.2}
          color="white"
          className="absolute inset-0 m-2.5 flex items-center justify-center"
        />
      )}
    </div>
  );
};

export default FilePreview;
