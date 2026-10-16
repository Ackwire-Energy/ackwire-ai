/**
 * The forum's shared pieces (telas/Forum.html, D45), for the forum pages, the
 * chat (topic and suggestion cards) and issues ("Avaliar no fórum").
 */
export {
  ForumMessageCard,
  ForumSuggestionCard,
  forumSuggestionOf,
  forumTopicOfMessage,
  IssueForumCard,
} from "./forum/cards";
export { NewTopicDialog, type NewTopicPreset, TEMPLATES } from "./forum/NewTopicDialog";
export { ParticipantsDialog } from "./forum/ParticipantsDialog";
export {
  agentMode,
  deadlineLabel,
  ForumStatusChip,
  OriginLink,
  SeatAvatar,
  StanceChip,
  TopicTrack,
  useForumWho,
  useOrigin,
  useStanceText,
} from "./forum/pieces";
export { headlineOf, SynthesisCard } from "./forum/Synthesis";
