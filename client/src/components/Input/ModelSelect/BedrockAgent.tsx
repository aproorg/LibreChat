import { SelectDropDown, SelectDropDownPop } from '~/components/ui';
import type { TModelSelectProps } from '~/common';
import { cn, cardStyle } from '~/utils/';

export default function BedrockAgent({
  conversation,
  models,
  setOption,
  showAbove = true,
  popover = false,
}: TModelSelectProps) {
  const Menu = popover ? SelectDropDownPop : SelectDropDown;

  return (
    <Menu
      value={conversation?.model ?? ''}
      setValue={(value: string) => setOption('model', value)}
      availableValues={models}
      showAbove={showAbove}
      className={cn(
        cardStyle,
        'z-50 flex h-[40px] w-48 flex-none items-center justify-center px-4 hover:cursor-pointer',
      )}
    />
  );
}
