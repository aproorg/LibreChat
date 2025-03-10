import { useState } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { useLocalize, useCopyToClipboard } from '~/hooks';
import { Clipboard, CheckMark } from '~/components/svg';

type THoverButtons = {
  message: TMessage;
};

export default function MinimalHoverButtons({ message }: THoverButtons) {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = useCopyToClipboard({ text: message.text, content: message.content });

  return (
    <div className="visible mt-0 flex justify-center gap-1 self-end text-gray-400 lg:justify-start">
      <button
        className="ml-0 flex items-center gap-1.5 rounded-md p-1 text-xs hover:text-gray-900 md:group-hover:visible md:group-[.final-completion]:visible"
        onClick={() => copyToClipboard(setIsCopied)}
        type="button"
        title={
          isCopied ? localize('com_ui_copied_to_clipboard') : localize('com_ui_copy_to_clipboard')
        }
      >
        {isCopied ? <CheckMark className="h-[18px] w-[18px]" /> : <Clipboard />}
      </button>
    </div>
  );
}
