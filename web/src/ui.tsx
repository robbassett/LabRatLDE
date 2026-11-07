import { ChevronDown, X } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Button,
  ComboBox as AriaComboBox,
  Dialog as AriaDialog,
  Heading,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  Separator,
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  Text,
  Tooltip as AriaTooltip,
  TooltipTrigger,
  type Key,
  type MenuItemProps,
  type TabListProps,
  type TabPanelProps,
  type TabProps,
  type TabsProps,
} from 'react-aria-components';

// Thin, styled wrappers over react-aria-components (SPEC-025 design §3.2). They
// carry no business logic: keyboard, focus and screen-reader behaviour come
// from React Aria.

// Dialog is a modal: focus moves in and is trapped, Escape or the close button
// closes it, and focus returns to whatever opened it.
export function Dialog({
  title,
  isOpen,
  onClose,
  children,
  wide,
  role = 'dialog',
}: {
  title: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  role?: 'dialog' | 'alertdialog';
}) {
  return (
    <ModalOverlay className="modal-overlay" isOpen={isOpen} onOpenChange={(open) => !open && onClose()} isDismissable>
      <Modal className={wide ? 'modal wide' : 'modal'}>
        <AriaDialog className="dialog" role={role}>
          <div className="dialog-head">
            <Heading slot="title">{title}</Heading>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

// Drawer is the sidebar below 1024 px: a modal sheet from the left.
export function Drawer({ label, isOpen, onClose, children }: { label: string; isOpen: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <ModalOverlay className="modal-overlay drawer-overlay" isOpen={isOpen} onOpenChange={(open) => !open && onClose()} isDismissable>
      <Modal className="modal drawer">
        <AriaDialog className="drawer-body" aria-label={label}>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

// Menu is a button that opens a menu of actions.
export function Menu({
  label,
  icon,
  ariaLabel,
  className = 'btn',
  children,
  onAction,
  chevron = true,
}: {
  label?: ReactNode;
  icon?: ReactNode;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
  onAction?: (key: Key) => void;
  chevron?: boolean;
}) {
  return (
    <MenuTrigger>
      <Button className={className} aria-label={ariaLabel}>
        {icon}
        {label}
        {chevron && <ChevronDown size={14} aria-hidden="true" />}
      </Button>
      <Popover className="popover" placement="bottom end">
        <AriaMenu className="menu" onAction={onAction}>
          {children}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}

export function MenuItem({ danger, className, ...props }: MenuItemProps & { danger?: boolean }) {
  return <AriaMenuItem {...props} className={`menu-item${danger ? ' danger' : ''}${className ? ` ${String(className)}` : ''}`} />;
}

export function MenuSeparator() {
  return <Separator className="menu-sep" />;
}

// IconButton is an icon-only button with an accessible name and a tooltip (SPEC-025-R04).
export function IconButton({
  label,
  onPress,
  children,
  className = 'btn btn-ghost btn-icon',
  isDisabled,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  className?: string;
  isDisabled?: boolean;
}) {
  return (
    <TooltipTrigger delay={500}>
      <Button className={className} aria-label={label} onPress={onPress} isDisabled={isDisabled}>
        {children}
      </Button>
      <AriaTooltip className="tooltip" offset={6}>
        {label}
      </AriaTooltip>
    </TooltipTrigger>
  );
}

export type ComboItem = { id: string; name: string; hint?: string };

// ComboBox is a text field with a filtered list of suggestions. With
// allowsCustomValue the typed text stands even if it matches nothing.
export function ComboBox({
  label,
  hint,
  items,
  inputValue,
  onInputChange,
  selectedKey,
  onSelectionChange,
  allowsCustomValue,
  isRequired,
}: {
  label: string;
  hint?: string;
  items: ComboItem[];
  inputValue?: string;
  onInputChange?: (v: string) => void;
  selectedKey?: string | null;
  onSelectionChange?: (key: string | null) => void;
  allowsCustomValue?: boolean;
  isRequired?: boolean;
}) {
  return (
    <AriaComboBox
      className="combo field"
      defaultItems={items}
      inputValue={inputValue}
      onInputChange={onInputChange}
      selectedKey={selectedKey}
      onSelectionChange={onSelectionChange ? (k) => onSelectionChange(k === null ? null : String(k)) : undefined}
      allowsCustomValue={allowsCustomValue}
      isRequired={isRequired}
      menuTrigger="focus"
    >
      <Label className="field-label">{label}</Label>
      <div className="combo-input">
        <Input />
        <Button className="btn btn-icon" aria-label={`Show ${label.toLowerCase()} options`}>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </div>
      {hint && (
        <Text slot="description" className="field-hint">
          {hint}
        </Text>
      )}
      <Popover className="popover">
        <ListBox<ComboItem> className="listbox">
          {(item) => (
            <ListBoxItem className="listbox-item" id={item.id} textValue={item.name}>
              {item.name}
              {item.hint && <span className="muted"> · {item.hint}</span>}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}

// Tabs inside a view (experiment Overview/Protocol/Settings, To do, Add input).
export function Tabs(props: TabsProps) {
  return <AriaTabs {...props} />;
}

export function TabList<T extends object>(props: TabListProps<T>) {
  return <AriaTabList {...props} className="rac-tablist" />;
}

export function Tab(props: TabProps) {
  return <AriaTab {...props} className="rac-tab" />;
}

export function TabPanel(props: TabPanelProps) {
  return <AriaTabPanel {...props} className="rac-tabpanel" />;
}
