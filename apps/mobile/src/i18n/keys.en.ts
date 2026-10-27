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
    server: {
      line: "Server: {{host}} ·",
      change: "Change",
      title: "Your server",
      subtitle: "Your team's agentes.chat address, the same one you see in the browser.",
      label: "Server address",
      placeholder: "agentes.yourteam.ts.net",
      use: "Use this server",
      checking: "Checking…",
      scan: "Scan QR code",
      backTo: "Back to {{host}}",
      now: "Now on {{host}}",
      invalid: "Check the address, something like agentes.yourteam.ts.net.",
      unreachable: "We can't reach {{host}}. Check the address and your connection, and try again.",
      unreachableTailscale:
        "We can't reach {{host}}. It's on Tailscale: open the Tailscale app, connect and try again.",
      certificate: "The certificate of {{host}} isn't valid. Talk to whoever runs the server.",
      notAgentes: "{{host}} isn't an agentes.chat server. Check the address.",
      serverTooOld: "{{host}} needs an update to work with this app.",
      appTooOld: "Update the agentes app to use {{host}}.",
      down: {
        title: "Your server isn't answering",
        text: "{{host}} didn't answer. It may be down or outside your network. The app opens on its own as soon as it's back.",
      },
    },
    connect: {
      title: "Connect to this server?",
      titleSignIn: "Sign in with the computer's account?",
      on: "Server: {{host}}",
      leave: "You'll be signed out of the current account on this phone.",
      confirm: "Connect",
      checking: "Checking the server…",
      notALink: "This link isn't from an agentes.chat server.",
      tokenFailed: "The code expired or was already used. Sign in with your email, or show a new code on the computer.",
    },
    scan: {
      hint: "Point at the QR code on the computer.",
      notOurs: "This QR code isn't from an agentes.chat server.",
      cameraTitle: "Use the camera",
      cameraText: "It's only used to read the QR code.",
      allow: "Allow camera",
      settings: "Open Settings",
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
      "You're the only owner of an organization with other members. On the website, in People, make someone else an owner, then come back.",
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
