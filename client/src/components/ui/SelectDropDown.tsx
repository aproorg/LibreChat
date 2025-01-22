import React from 'react';
import {
  Label,
  Listbox,
  Transition,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from '@headlessui/react';
import type { Option, OptionWithIcon, DropdownValueSetter } from '~/common';
import CheckMark from '~/components/svg/CheckMark';
import { useMultiSearch } from './MultiSearch';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils/';

const { useRef, useEffect, useState } = React;

type SelectDropDownProps = {
  id?: string;
  title?: string;
  disabled?: boolean;
  value: string | null | Option | OptionWithIcon;
  setValue: DropdownValueSetter | ((value: string | Option | OptionWithIcon) => void);
  tabIndex?: number;
  availableValues?: string[] | Option[] | OptionWithIcon[];
  emptyTitle?: boolean;
  showAbove?: boolean;
  showLabel?: boolean;
  iconSide?: 'left' | 'right';
  optionIconSide?: 'left' | 'right';
  renderOption?: () => React.ReactNode;
  containerClassName?: string;
  currentValueClass?: string;
  optionsListClass?: string;
  optionsClass?: string;
  subContainerClassName?: string;
  className?: string;
  placeholder?: string;
  searchClassName?: string;
  searchPlaceholder?: string;
  showOptionIcon?: boolean;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
};

function getOptionText(option: string | Option | OptionWithIcon): string {
  if (typeof option === 'string') {
    return option;
  }
  if ('label' in option) {
    return option.label ?? '';
  }
  if ('value' in option) {
    return (option.value ?? '') + '';
  }
  return '';
}

const SelectDropDown: React.FC<SelectDropDownProps> = ({
  title: _title,
  value,
  disabled,
  setValue,
  availableValues,
  showAbove = false,
  showLabel = true,
  emptyTitle = false,
  iconSide = 'right',
  optionIconSide = 'left',
  placeholder,
  containerClassName,
  optionsListClass,
  optionsClass,
  currentValueClass,
  subContainerClassName,
  className,
  renderOption,
  searchClassName,
  searchPlaceholder,
  showOptionIcon = false,
  isOpen,
  onOpenChange,
}) => {
  const localize = useLocalize();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{
    top: number;
    left: number;
    width: number;
    showAbove?: boolean;
  }>({ top: 0, left: 0, width: 0 });

  useEffect(() => {
    const updatePosition = () => {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const spaceBelow = viewportHeight - rect.bottom;
        const spaceAbove = rect.top;
        const dropdownHeight = 300; // Maximum height of dropdown

        // Determine if dropdown should appear above or below
        const showAbove = spaceBelow < dropdownHeight && spaceAbove > spaceBelow;

        setDropdownPosition({
          top: showAbove 
            ? rect.top + window.scrollY - dropdownHeight - 8
            : rect.bottom + window.scrollY + 8,
          left: rect.left + window.scrollX,
          width: rect.width,
          showAbove
        });
      }
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition);
      window.removeEventListener('resize', updatePosition);
    };
  }, []);
  const transitionProps = { 
    className: dropdownPosition.showAbove ? 'bottom-full mb-3' : 'top-full mt-3'
  };

  let title = _title;

  if (emptyTitle) {
    title = '';
  } else if (!(title ?? '')) {
    title = localize('com_ui_model');
  }

  const values = availableValues ?? [];

  // Determine if we should convert this component into a searchable select.  If we have enough elements, a search
  // input will appear near the top of the menu, allowing correct filtering of different model menu items. This will
  // reset once the component is unmounted (as per a normal search)
  const [filteredValues, searchRender] = useMultiSearch<string[] | Option[]>({
    availableOptions: values,
    placeholder: searchPlaceholder,
    getTextKeyOverride: (option) => getOptionText(option).toUpperCase(),
    className: searchClassName,
    disabled,
  });
  const hasSearchRender = searchRender != null;
  const options = hasSearchRender ? filteredValues : values;

  const renderIcon = showOptionIcon && value != null && (value as OptionWithIcon).icon != null;

  // Add click handler debug
  const handleClick = (newOpen: boolean) => {
    console.log('SelectDropDown button clicked, setting open to:', newOpen);
    onOpenChange?.(newOpen);
  };

  return (
    <div 
      className={cn('flex items-center justify-center gap-2 relative', containerClassName ?? '')}
      style={{ isolation: 'isolate', zIndex: 100 }}
      data-testid="select-dropdown-container"
      onClick={() => console.log('Container clicked')}
    >
      <div 
        className={cn('relative w-full', subContainerClassName ?? '')}
        style={{ position: 'relative', zIndex: 'auto' }}
        onClick={(e) => {
          console.log('Inner container clicked');
          e.stopPropagation();
        }}
      >
        <Listbox 
          value={value} 
          onChange={(val: string | Option | OptionWithIcon | null) => {
            if (val !== null) {
              setValue(val);
              onOpenChange?.(false);
            }
          }} 
          disabled={disabled}
        >
          {({ open: listboxOpen }) => {
            const open = isOpen ?? listboxOpen;
            console.log('SelectDropDown Debug:', {
              value,
              values: values.length,
              availableValues: values,
              disabled,
              className,
              showAbove,
              hasSearchRender,
              options: options.length,
              containerClassName,
              subContainerClassName,
              title,
              placeholder,
              renderIcon,
              showLabel,
              isOpen: open
            });
            
            return (
            <>
              <ListboxButton
                ref={buttonRef}
                data-testid="select-dropdown-button"
                aria-label={title || 'Select option'}
                onClick={(e) => {
                  console.log('ListboxButton clicked');
                  handleClick(!open);
                  e.stopPropagation();
                }}
                className={cn(
                  'relative flex w-full cursor-pointer flex-col rounded-md border-2 border-black/10 bg-white py-2 pl-3 pr-10 text-left hover:border-green-500 dark:border-gray-600 dark:bg-gray-700 sm:text-sm',
                  'focus:outline-none focus:ring-2 focus:ring-green-500',
                  className ?? '',
                )}
              >
                {' '}
                {showLabel && (
                  <Label
                    className="block text-xs text-gray-700 dark:text-gray-500 "
                    id="headlessui-listbox-label-:r1:"
                    data-headlessui-state=""
                  >
                    {title}
                  </Label>
                )}
                <span className="inline-flex w-full truncate">
                  <span
                    className={cn(
                      'flex h-6 items-center gap-1 truncate text-sm text-gray-800 dark:text-white',
                      !showLabel ? 'text-xs' : '',
                      currentValueClass ?? '',
                    )}
                  >
                    {!showLabel && !emptyTitle && (
                      <span className="text-xs text-gray-700 dark:text-gray-500">{title}:</span>
                    )}
                    {renderIcon && optionIconSide !== 'right' && (
                      <span className="icon-md flex items-center">
                        {(value as OptionWithIcon).icon}
                      </span>
                    )}
                    {renderIcon && (
                      <span className="icon-md absolute right-0 mr-8 flex items-center">
                        {(value as OptionWithIcon).icon}
                      </span>
                    )}
                    {(() => {
                      if (!value) {
                        return <span className="text-text-secondary">{placeholder}</span>;
                      }

                      if (typeof value !== 'string') {
                        return value.label ?? '';
                      }

                      return value;
                    })()}
                  </span>
                </span>
                <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                  <svg
                    stroke="currentColor"
                    fill="none"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4  text-gray-400"
                    height="1em"
                    width="1em"
                    xmlns="http://www.w3.org/2000/svg"
                    style={showAbove ? { transform: 'scaleY(-1)' } : {}}
                  >
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </span>
              </ListboxButton>
              <Transition
                show={open}
                as={React.Fragment}
                enter="transition ease-out duration-100"
                enterFrom="opacity-0 -translate-y-1"
                enterTo="opacity-100 translate-y-0"
                leave="transition ease-in duration-75"
                leaveFrom="opacity-100 translate-y-0"
                leaveTo="opacity-0 -translate-y-1"
                {...transitionProps}
              >
                <ListboxOptions
                  className={cn(
                    'fixed mt-2 max-h-60 overflow-auto rounded-lg border-2 bg-white text-xs shadow-lg ring-1 ring-black/10 dark:border-gray-600 dark:bg-gray-700 dark:ring-white/20',
                    'focus:outline-none focus:ring-2 focus:ring-green-500',
                    'transform-gpu transition-all duration-100 ease-in-out',
                    optionsListClass ?? '',
                  )}
                  style={{
                    position: 'fixed',
                    left: `${dropdownPosition.left}px`,
                    top: `${dropdownPosition.top}px`,
                    width: `${dropdownPosition.width}px`,
                    maxHeight: '300px',
                    zIndex: 99999,
                    opacity: open ? 1 : 0,
                    visibility: open ? 'visible' : 'hidden',
                    transform: open ? 'translateY(0)' : dropdownPosition.showAbove ? 'translateY(10px)' : 'translateY(-10px)',
                    pointerEvents: open ? 'auto' : 'none',
                    backgroundColor: 'var(--background)',
                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                    isolation: 'isolate'
                  }}
                >
                  {renderOption && (
                    <ListboxOption
                      key={'listbox-render-option'}
                      value={null}
                      className={cn(
                        'group relative flex h-[42px] cursor-pointer select-none items-center overflow-hidden pl-3 pr-9 text-gray-800 hover:bg-gray-20 dark:text-white dark:hover:bg-gray-700',
                        optionsClass ?? '',
                      )}
                    >
                      {renderOption()}
                    </ListboxOption>
                  )}
                  {searchRender}
                  {options.map((option: string | Option, i: number) => {
                    if (!option) {
                      return null;
                    }

                    const currentLabel =
                      typeof option === 'string' ? option : option.label ?? option.value ?? '';
                    const currentValue = typeof option === 'string' ? option : option.value ?? '';
                    const currentIcon =
                      typeof option === 'string' ? null : (option.icon as React.ReactNode) ?? null;
                    let activeValue: string | number | null | Option = value;
                    if (typeof activeValue !== 'string') {
                      activeValue = activeValue?.value ?? '';
                    }

                    return (
                      <ListboxOption
                        key={i}
                        value={option}
                        className={({ active }) =>
                          cn(
                            'group relative flex h-[42px] cursor-pointer select-none items-center overflow-hidden pl-3 pr-9 text-gray-800 hover:bg-gray-20 dark:text-white dark:hover:bg-gray-600',
                            active ? 'bg-surface-active text-text-primary' : '',
                            optionsClass ?? '',
                          )
                        }
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          <span
                            className={cn(
                              'flex h-6 items-center gap-1 text-gray-800 dark:text-gray-200',
                              option === value ? 'font-semibold' : '',
                              iconSide === 'left' ? 'ml-4' : '',
                            )}
                          >
                            {currentIcon != null && (
                              <span
                                className={cn(
                                  'mr-1',
                                  optionIconSide === 'right' ? 'absolute right-0 pr-2' : '',
                                )}
                              >
                                {currentIcon}
                              </span>
                            )}
                            {currentLabel}
                          </span>
                          {currentValue === activeValue && (
                            <span
                              className={cn(
                                'absolute inset-y-0 flex items-center text-gray-800 dark:text-gray-200',
                                iconSide === 'left' ? 'left-0 pl-2' : 'right-0 pr-3',
                              )}
                            >
                              <CheckMark />
                            </span>
                          )}
                        </span>
                      </ListboxOption>
                    );
                  })}
                </ListboxOptions>
              </Transition>
            </>
            );
          }}
        </Listbox>
      </div>
    </div>
  );
}

export default SelectDropDown;
