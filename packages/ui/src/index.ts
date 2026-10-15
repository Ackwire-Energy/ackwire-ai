/**
 * @agenteschat/ui — the agentes design system in React.
 * Visuals come from `styles.css` (tokens + `ac-*` classes, ported from
 * docs/design); keyboard, focus and screen-reader mechanics from Radix
 * primitives. Components take every user-facing string as a prop: the app
 * translates them with `t()`.
 */

export {
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAccessory,
  AgentAccessoryLayer,
  type AgentAppearance,
  type AgentColor,
  type AgentEyes,
  agentGradient,
  appearanceStyle,
  normalizeAppearance,
  randomAppearance,
} from "./components/AgentLook";
export { ApprovalCard, type ApprovalCardProps, type ApprovalStatus } from "./components/ApprovalCard";
export {
  type AgentState,
  Avatar,
  type AvatarKind,
  type AvatarProps,
  AvatarStack,
  initialsOf,
} from "./components/Avatar";
export { Button, type ButtonProps, type ButtonVariant } from "./components/Button";
export {
  Checkbox,
  CheckboxPill,
  type CheckboxProps,
  Radio,
  RadioCard,
  RadioGroup,
  Switch,
} from "./components/Checkbox";
export { AttentionNote, Chip, type ChipProps, type ChipTone, CountBadge } from "./components/Chip";
export { CommandPalette, filterPalette, type PaletteItem } from "./components/CommandPalette";
export {
  Composer,
  type ComposerCommand,
  type ComposerCommands,
  type ComposerMentions,
  type ComposerProps,
  type ComposerSuggestion,
  linkQuery,
  mentionQuery,
} from "./components/Composer";
export { DatePicker, type DatePickerProps, monthGrid, parseYmd, ymd } from "./components/DatePicker";
export { Dialog, DialogBody, DialogFooter, type DialogProps, DialogSearchList } from "./components/Dialog";
export { Diff, type DiffKind, type DiffLine, diffLines } from "./components/Diff";
export { AffixInput, Field, type FieldProps, Input, SearchInput, Textarea, useFieldControl } from "./components/Field";
export {
  FILTER_SEARCH_AFTER,
  FilterBar,
  FilterChip,
  type FilterChipProps,
  type FilterOption,
} from "./components/FilterChip";
export { Kbd, modKey } from "./components/Kbd";
export { Logo, LogoMark, type LogoProps } from "./components/Logo";
export { Mention } from "./components/Mention";
export { Menu, MenuItem, MenuRadioGroup, MenuSeparator } from "./components/Menu";
export { DayDivider, Message, type MessageProps, MessageText } from "./components/Message";
export { glowOptions, PixelSky, SkyGlow } from "./components/PixelSky";
export { Popover } from "./components/Popover";
export {
  modeOf,
  monthlyKindOf,
  type RecurrenceLabels,
  type RecurrenceMode,
  RecurrencePicker,
  type RecurrencePickerProps,
} from "./components/RecurrencePicker";
export { Segmented, type SegmentedOption, SplitButton } from "./components/Segmented";
export { Select, type SelectOption, type SelectProps } from "./components/Select";
export { Sheet, type SheetProps } from "./components/Sheet";
export {
  SKELETON_DELAY_MS,
  Skeleton,
  SkeletonCard,
  SkeletonConversation,
  SkeletonGroup,
  SkeletonList,
  SkeletonMessage,
  type SkeletonProps,
  SkeletonRow,
  Spinner,
  TopProgress,
  useDelayed,
} from "./components/Skeleton";
export {
  Alert,
  Card,
  EmptyState,
  type EmptyStateProps,
  LIST_STAGGER_MS,
  List,
  Meter,
  OptionCard,
  Steps,
} from "./components/Surfaces";
export { type TabItem, TabPanel, Tabs } from "./components/Tabs";
export { normalizeTime, TimeSelect, type TimeSelectProps, timeOptions } from "./components/TimeSelect";
export { TimezoneSelect, type TimezoneSelectLabels, type TimezoneSelectProps } from "./components/TimezoneSelect";
export { Token, TokenList } from "./components/Token";
export { Reaction, Reactions, type WorkStep, WorkSummary } from "./components/Work";
export { cx } from "./cx";
export { Icon, type IconName, type IconProps, iconNames, icons } from "./icons/Icon";
export {
  BUSINESS_DAYS,
  nextOccurrences,
  type RecurrenceFreq,
  type RecurrenceRule,
  ruleFor,
  WEEKDAYS,
  type Weekday,
  weekdayOf,
  weekdayOfYmd,
  weekdayPosition,
  zonedInstant,
} from "./recurrence";
export { pixelBurst } from "./sky/burst";
export { ditherCells, ditherSvg, ditherTones, ditherUrl } from "./sky/dither";
export {
  drawSprite,
  prefersReducedMotion,
  redrawSkies,
  type SkyBlob,
  type SkyFrame,
  type SkyOptions,
  SPRITE,
  startSky,
} from "./sky/engine";
export { agentTones, EYE, glowTones, mix, parseColor, pixelOf, SKY_TONES, softTones, spriteTone } from "./sky/tones";
export {
  allZones,
  cityOf,
  FALLBACK_ZONES,
  filterZones,
  offsetLabel,
  offsetMinutes,
  parseOffsetQuery,
  regionOf,
  type ZoneOption,
  type ZoneRegion,
  zoneOption,
  zoneOptions,
} from "./timezones";
