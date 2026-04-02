import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react-dom";
import { createPortal } from "react-dom";
import { useEffect, useId, useMemo, useRef, useState } from "react";

type SelectDropdownValue = string | number;

export interface SelectDropdownOption<T extends SelectDropdownValue> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectDropdownProps<T extends SelectDropdownValue> {
  id?: string;
  value: T | null | undefined;
  options: SelectDropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  labelId?: string;
  ariaLabel?: string;
  placeholder?: string;
  triggerClassName?: string;
  panelClassName?: string;
}

export function SelectDropdown<T extends SelectDropdownValue>({
  id,
  value,
  options,
  onChange,
  disabled = false,
  labelId,
  ariaLabel,
  placeholder = "Select…",
  triggerClassName = "form-input select-dropdown-trigger",
  panelClassName = "select-dropdown-panel",
}: SelectDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const typeaheadBufferRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);

  const { refs, floatingStyles, elements } = useFloating({
    placement: "bottom-start",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
  });

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );

  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  useEffect(() => {
    refs.setReference(triggerRef.current);
  }, [refs]);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      const referenceEl = elements.reference as Element | null;
      const floatingEl = elements.floating as Element | null;

      if ((referenceEl && referenceEl.contains(target)) || (floatingEl && floatingEl.contains(target))) {
        return;
      }

      setOpen(false);
      setActiveIndex(null);
    }

    const timeoutId = window.setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, elements.reference, elements.floating]);

  useEffect(() => {
    if (!open || activeIndex == null) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex != null && options[activeIndex]) return;

    const fallbackIndex = selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled);
    setActiveIndex(fallbackIndex >= 0 ? fallbackIndex : null);
  }, [open, activeIndex, options, selectedIndex]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current != null) {
      window.clearTimeout(typeaheadTimerRef.current);
    }
  }, []);

  function openDropdown(preferredIndex?: number) {
    if (disabled || options.length === 0) return;

    const nextIndex = preferredIndex ?? (selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled));
    setActiveIndex(nextIndex >= 0 ? nextIndex : null);
    setOpen(true);
  }

  function closeDropdown() {
    setOpen(false);
    setActiveIndex(null);
  }

  function moveActive(step: 1 | -1) {
    const enabledOptions = options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled);

    if (enabledOptions.length === 0) return;

    const currentEnabledIndex = enabledOptions.findIndex(({ index }) => index === activeIndex);
    const nextEnabledIndex = currentEnabledIndex === -1
      ? (step === 1 ? 0 : enabledOptions.length - 1)
      : (currentEnabledIndex + step + enabledOptions.length) % enabledOptions.length;

    setActiveIndex(enabledOptions[nextEnabledIndex]?.index ?? null);
  }

  function selectIndex(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;

    onChange(option.value);
    closeDropdown();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function matchTypeahead(key: string) {
    const normalizedKey = key.toLowerCase();
    typeaheadBufferRef.current = `${typeaheadBufferRef.current}${normalizedKey}`;

    if (typeaheadTimerRef.current != null) {
      window.clearTimeout(typeaheadTimerRef.current);
    }

    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadBufferRef.current = "";
    }, 500);

    const enabledOptions = options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled);

    if (enabledOptions.length === 0) return;

    const currentEnabledIndex = enabledOptions.findIndex(({ index }) => index === activeIndex);
    const rotationStart = currentEnabledIndex >= 0 ? currentEnabledIndex + 1 : 0;
    const rotatedOptions = enabledOptions.slice(rotationStart).concat(enabledOptions.slice(0, rotationStart));
    const match = rotatedOptions.find(({ option }) => option.label.toLowerCase().startsWith(typeaheadBufferRef.current));

    if (!match) return;

    setActiveIndex(match.index);
    if (!open) {
      setOpen(true);
    }
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled || options.length === 0) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openDropdown(selectedIndex >= 0 ? selectedIndex : undefined);
        else moveActive(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (!open) openDropdown(selectedIndex >= 0 ? selectedIndex : options.length - 1);
        else moveActive(-1);
        return;
      case "Home":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(options.findIndex((option) => !option.disabled));
        return;
      case "End":
        if (!open) return;
        event.preventDefault();
        for (let index = options.length - 1; index >= 0; index -= 1) {
          if (!options[index]?.disabled) {
            setActiveIndex(index);
            break;
          }
        }
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (!open) {
          openDropdown();
        } else if (activeIndex != null) {
          selectIndex(activeIndex);
        }
        return;
      case "Escape":
        if (!open) return;
        event.preventDefault();
        closeDropdown();
        return;
      case "Tab":
        if (open) closeDropdown();
        return;
      default:
        if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          matchTypeahead(event.key);
        }
    }
  }

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex != null ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-labelledby={labelId}
        aria-label={labelId ? undefined : ariaLabel}
        disabled={disabled}
        className={triggerClassName}
        onClick={() => {
          if (open) closeDropdown();
          else openDropdown();
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="select-dropdown-trigger-value">{selectedOption?.label ?? placeholder}</span>
        <span className="select-dropdown-trigger-caret" aria-hidden="true">▾</span>
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={refs.setFloating}
          id={listboxId}
          role="listbox"
          aria-labelledby={labelId}
          aria-label={labelId ? undefined : ariaLabel}
          className={panelClassName}
          style={{
            ...floatingStyles,
            zIndex: 1050,
            width: elements.reference ? elements.reference.getBoundingClientRect().width : "auto",
          }}
        >
          {options.map((option, index) => {
            const isSelected = index === selectedIndex;
            const isActive = index === activeIndex;

            return (
              <div
                key={`${option.value}`}
                id={`${listboxId}-option-${index}`}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                className={[
                  "select-dropdown-option",
                  isActive ? "select-dropdown-option--active" : "",
                  isSelected ? "select-dropdown-option--selected" : "",
                  option.disabled ? "select-dropdown-option--disabled" : "",
                ].filter(Boolean).join(" ")}
                onMouseEnter={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => selectIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectIndex(index);
                  }
                }}
              >
                {option.label}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
