/**
 * @agenteschat/ui — the agentes design system in React.
 * Visuals come from `styles.css` (tokens + `ac-*` classes, ported from
 * docs/design); keyboard, focus and screen-reader mechanics from Radix
 * primitives. Components take every user-facing string as a prop: the app
 * translates them with `t()`.
 */

export {
  ACCESSORIES,
  ACCESSORY_REACH,
  AGENT_GRADIENTS,
  BODY_CUT,
  BODY_RADIUS,
  bodyPath,
  bodySvg,
  bodyTones,
  drawAccessory,
  drawAgent,
  drawEyes,
  EXPRESSIONS,
  type Expression,
  EYE_STYLES,
  eyeShapes,
  idlePose,
  type Pose,
  spriteGrid,
} from "./agent/engine.js";
export {
  type AgentReaction,
  addLiveAgent,
  agentReactionOf,
  getGaze,
  playAgentReaction,
  REACTION_SECONDS,
  reactionPose,
  setGaze,
} from "./agent/live";
export {
  BRAIN_GRID,
  BRAIN_KINDS,
  BRAIN_STATES,
  type BrainAgentLook,
  drawBrain,
} from "./brain/portrait.js";
export {
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAccessory,
  type AgentAppearance,
  type AgentColor,
  type AgentEyes,
  agentGradient,
  appearanceStyle,
  normalizeAppearance,
  randomAppearance,
} from "./components/AgentLook";
export { ApprovalCard, type ApprovalCardProps, type ApprovalStatus } from "./components/ApprovalCard";
export { type AutonomyKind, AutonomyPixels, drawAutonomy } from "./components/AutonomyPixels";
export {
  type AgentState,
  Avatar,
  type AvatarKind,
  type AvatarProps,
  AvatarStack,
  initialsOf,
} from "./components/Avatar";
export {
  BRAIN_ICONS,
  BrainIcon,
  BrainLogo,
  BrainPortrait,
  type BrainPortraitKind,
  type BrainPortraitProps,
  type BrainPortraitState,
} from "./components/Brain";
export { Button, type ButtonProps, type ButtonVariant } from "./components/Button";
export { Carousel, type CarouselProps } from "./components/Carousel";
export {
  Checkbox,
  CheckboxPill,
  type CheckboxProps,
  Radio,
  RadioCard,
  RadioGroup,
  Switch,
} from "./components/Checkbox";
export { AttentionNote, Chip, type ChipProps, type ChipTone, CountBadge, CountChip } from "./components/Chip";
export { CommandPalette, filterPalette, type PaletteItem } from "./components/CommandPalette";
export {
  Composer,
  type ComposerChoice,
  type ComposerCommand,
  type ComposerCommands,
  ComposerFile,
  type ComposerFormatLabels,
  type ComposerMentions,
  type ComposerProps,
  type ComposerSuggestion,
  type ComposerWorking,
  linkQuery,
  mentionQuery,
  type SendChoice,
  sendChoice,
} from "./components/Composer";
export {
  ComputerIcon,
  type ComputerKind,
  ComputerPortrait,
  type ComputerPortraitProps,
  type ComputerState,
} from "./components/Computer";
export { DatePicker, type DatePickerProps, monthGrid, parseYmd, ymd } from "./components/DatePicker";
export {
  DetailsDialog,
  type DetailsDialogPageLink,
  type DetailsDialogProps,
  DetailsSection,
} from "./components/DetailsDialog";
export { Dialog, DialogBody, DialogFooter, type DialogProps, DialogSearchList } from "./components/Dialog";
export { Diff, type DiffKind, type DiffLine, diffLines } from "./components/Diff";
export { drawEffort, EffortPixels, type EffortStep } from "./components/EffortPixels";
export {
  EMOJI_COLUMNS,
  EmojiPicker,
  type EmojiPickerLabels,
  EmojiPickerPopover,
  readRecentEmoji,
  rememberEmoji,
} from "./components/EmojiPicker";
export { AffixInput, Field, type FieldProps, Input, SearchInput, Textarea, useFieldControl } from "./components/Field";
export {
  FILTER_SEARCH_AFTER,
  FilterBar,
  FilterChip,
  type FilterChipProps,
  type FilterOption,
} from "./components/FilterChip";
export {
  Convergence,
  type ForumTrackItem,
  type ForumTrackKind,
  layoutTrack,
  RoundTrack,
  roundLabelBoxes,
  StanceLane,
  TRACK_SIZES,
  type TrackLayout,
  type TrackLayoutItem,
  type TrackSize,
  trackItemAt,
} from "./components/ForumPixels";
export { Kbd, modKey } from "./components/Kbd";
export { Logo, LogoMark, type LogoProps } from "./components/Logo";
export { AgentReadingBook } from "./components/MemoryPixels";
export { Mention } from "./components/Mention";
export {
  Menu,
  MenuAt,
  MenuCheckboxItem,
  MenuHeading,
  MenuItem,
  MenuNote,
  MenuRadioGroup,
  MenuReactions,
  MenuSeparator,
} from "./components/Menu";
export {
  MenuOverlay,
  MenuOverlayGroup,
  MenuOverlayItem,
  MenuOverlayRow,
  MenuOverlaySeparator,
} from "./components/MenuOverlay";
export { DayDivider, Message, type MessageProps, MessageText } from "./components/Message";
export { OptionList, type OptionListItem, type OptionListProps } from "./components/OptionList";
export {
  PixelDone,
  type PixelDoneProps,
  PixelStop,
  type PixelStopProps,
  pixelCell,
} from "./components/PixelMarks";
export { glowOptions, PixelSky, SkyGlow } from "./components/PixelSky";
export {
  ORBIT_RING,
  ORBIT_STEP_MS,
  orbitShades,
  PixelSpinner,
  type PixelSpinnerProps,
  type PixelSpinnerSize,
} from "./components/PixelSpinner";
export {
  PLAN_ALMOST,
  PlanMeter,
  type PlanMeterText,
  type PlanMeterUsage,
  type PlanMeterWindow,
  type PlanState,
  planState,
  planWindows,
} from "./components/PlanMeter";
export { Popover } from "./components/Popover";
export { ProviderLogo, type ProviderLogoProps } from "./components/ProviderLogo";
export {
  modeOf,
  monthlyKindOf,
  type RecurrenceLabels,
  type RecurrenceMode,
  RecurrencePicker,
  type RecurrencePickerProps,
} from "./components/RecurrencePicker";
export {
  BrowserMark,
  type BrowserPixelKind,
  BrowserStrip,
  CriteriaPixels,
  ExpiryFuse,
  PageSilhouette,
  PlanStrip,
  type PlanStripCell,
  planCellPixel,
  RunKey,
  RunLane,
  RunMark,
  type RunPixel,
  type RunPixelStatus,
  RunStrip,
  SkyStrip,
  STRIP_CELL,
  WorkSweep,
} from "./components/RunPixels";
export { Segmented, type SegmentedOption, SplitButton } from "./components/Segmented";
export { Select, type SelectOption, type SelectProps } from "./components/Select";
export { SettingNote, SettingRow, SettingsMore, SettingsSection } from "./components/Settings";
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
  CardFooter,
  CardHeader,
  EmptyState,
  type EmptyStateProps,
  LIST_STAGGER_MS,
  List,
  ListRow,
  type ListRowProps,
  Meter,
  OptionCard,
  Steps,
} from "./components/Surfaces";
export { type TabItem, TabPanel, Tabs } from "./components/Tabs";
export { normalizeTime, TimeSelect, type TimeSelectProps, timeOptions } from "./components/TimeSelect";
export { TimezoneSelect, type TimezoneSelectLabels, type TimezoneSelectProps } from "./components/TimezoneSelect";
export { Token, TokenList } from "./components/Token";
export {
  FilterToggle,
  type FilterToggleProps,
  SearchField,
  type SearchFieldProps,
  Toolbar,
} from "./components/Toolbar";
export {
  AskPixels,
  HappyAgent,
  SuggestSpark,
  TOOL_LEVEL_ORDER,
  ToolLevelBar,
  type ToolLevelKind,
  ToolLevelStrip,
  ToolLevelSwatch,
  toolLevelTones,
} from "./components/ToolPixels";
export { type UsageDay, type UsageDayPart, UsageDays, UsageSwatch } from "./components/UsageDays";
export { Reaction, Reactions, type WorkStep, WorkSummary } from "./components/Work";
export { COMPUTER_GRID, COMPUTER_KINDS, COMPUTER_STATES, drawComputer } from "./computer/portrait.js";
export { cx } from "./cx";
export {
  EMOJI_CATEGORIES,
  EMOJIS,
  type EmojiCategoryId,
  type EmojiEntry,
  emojiEntry,
  searchEmoji,
} from "./emoji-data";
export {
  applyFormat,
  codeBlock,
  FORMAT_KINDS,
  type FormatKind,
  formatShortcut,
  formatShortcutHint,
  insertText,
  linkSelection,
  prefixLines,
  type TextEdit,
  wrapSelection,
} from "./format";
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
