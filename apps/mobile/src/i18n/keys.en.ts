import type { MobileTranslations } from "./keys.pt-BR";

/** The app's own strings in English (same shape as keys.pt-BR.ts). */
export const mobileEn: MobileTranslations = {
  common: {
    back: "Back",
    cancel: "Cancel",
    close: "Close",
    continue: "Continue",
    done: "Done",
    retry: "Try again",
    loading: "Loading",
    or: "or",
  },
  auth: {
    skyLabel: "Sky with agents",
    social: {
      failed: "Couldn't sign you in right now. Try again.",
    },
    errors: {
      network: "No connection. Check the internet and try again.",
      generic: "Something went wrong. Try again.",
    },
  },
  org: {
    noneTitle: "You're not in an organization yet",
    noneSubtitle: "Ask someone on your team for an invitation, or create the organization on the website.",
    openSite: "Open the website",
    signOut: "Sign out",
  },
  account: {
    deleteSoleOwner:
      "You're the only owner of an organization with other members. Hand the organization to someone before deleting your account.",
    deleteFailed: "Couldn't delete your account right now. Try again.",
    deleted: "Your account was deleted.",
    signedOut: "You signed out.",
  },
  theme: {
    system: "Same as the phone",
    light: "Light",
    dark: "Dark",
  },
  push: {
    channel: "Alerts",
    channelDescription: "What's waiting for you, mentions and conversations.",
  },
  a11y: {
    agent: "{{name}}, agent",
    agentWorking: "{{name}}, agent, working",
    agentPlain: "Agent",
    person: "{{name}}",
    loading: "Loading",
    grabber: "Drag down to close",
    closeSheet: "Close",
    send: "Send",
    attach: "Attach and more",
    hold: "Hold to confirm",
    clearSearch: "Clear search",
  },
  composer: {
    placeholder: "Write a message",
    join: "Add to what it is doing",
    now: "Stop and send",
    choice: "How to send while the agent works",
  },
  search: {
    placeholder: "Search",
  },
};
