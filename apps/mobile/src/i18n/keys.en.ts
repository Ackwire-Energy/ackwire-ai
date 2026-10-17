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
    email: {
      title: "What's your email?",
      subtitle: "Use the same email you use at work.",
      placeholder: "you@company.com",
      invalid: "Check the email. Something seems to be missing.",
    },
    signIn: {
      passwordTitle: "Your password",
      passwordSubtitle: "For {{email}}",
      passwordPlaceholder: "Password",
      submit: "Sign in",
      forgot: "I forgot my password",
      noAccount: "No account yet?",
      createAccount: "Create account",
      wrong: "The email or password doesn't match.",
    },
    social: {
      google: "Continue with Google",
      apple: "Continue with Apple",
      failed: "Couldn't sign you in right now. Try again.",
    },
    signUp: {
      nameTitle: "What should we call you?",
      nameSubtitle: "Your name shows to the people and agents on your team.",
      namePlaceholder: "Your name",
      passwordTitle: "Create a password",
      passwordSubtitle: "At least 8 characters.",
      passwordPlaceholder: "New password",
      tooShort: "The password needs at least 8 characters.",
      submit: "Create account",
      haveAccount: "Already have an account?",
      signIn: "Sign in",
      closed: "For now, only people with an invitation can join.",
      taken: "There's already an account with this email.",
    },
    forgot: {
      title: "Let's change your password",
      subtitle: "We'll send a link to your email.",
      submit: "Send link",
      sentTitle: "Check your email",
      sentSubtitle: "If there's an account for {{email}}, the link arrives in a moment.",
      backToSignIn: "Back to sign in",
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
  },
  search: {
    placeholder: "Search",
  },
};
