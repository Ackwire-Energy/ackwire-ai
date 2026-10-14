/**
 * @agenteschat/ui — the agentes design system in React.
 * Visuals come from `styles.css` (tokens + `ac-*` classes, ported from
 * docs/design); keyboard, focus and screen-reader mechanics from Radix
 * primitives. Components take every user-facing string as a prop: the app
 * translates them with `t()`.
 */

export { ApprovalCard, type ApprovalCardProps, type ApprovalStatus } from "./components/ApprovalCard";
export { Avatar, type AvatarKind, type AvatarProps, AvatarStack, initialsOf } from "./components/Avatar";
export { Button, type ButtonProps, type ButtonVariant } from "./components/Button";
export { Checkbox, CheckboxPill, type CheckboxProps, Radio, RadioCard, RadioGroup } from "./components/Checkbox";
export { AttentionNote, Chip, type ChipProps, type ChipTone, CountBadge } from "./components/Chip";
export { Composer, type ComposerProps } from "./components/Composer";
export { DatePicker, type DatePickerProps, monthGrid, parseYmd, ymd } from "./components/DatePicker";
export { Dialog, DialogBody, DialogFooter, type DialogProps, DialogSearchList } from "./components/Dialog";
export { Diff, type DiffKind, type DiffLine, diffLines } from "./components/Diff";
export { AffixInput, Field, type FieldProps, Input, SearchInput, Textarea, useFieldControl } from "./components/Field";
export { Logo, LogoMark, type LogoProps } from "./components/Logo";
export { Mention } from "./components/Mention";
export { Menu, MenuItem, MenuRadioGroup, MenuSeparator } from "./components/Menu";
export { DayDivider, Message, type MessageProps, MessageText } from "./components/Message";
export { Popover } from "./components/Popover";
export { Select, type SelectOption, type SelectProps } from "./components/Select";
export { Sheet, type SheetProps } from "./components/Sheet";
export { Alert, Card, EmptyState, type EmptyStateProps, List, Meter, OptionCard, Steps } from "./components/Surfaces";
export { type TabItem, TabPanel, Tabs } from "./components/Tabs";
export { normalizeTime, TimeSelect, type TimeSelectProps, timeOptions } from "./components/TimeSelect";
export { Token, TokenList } from "./components/Token";
export { cx } from "./cx";
export { Icon, type IconName, type IconProps, iconNames, icons } from "./icons/Icon";
