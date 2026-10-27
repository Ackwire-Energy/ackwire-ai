import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

export const helpEn: Record<HelpSlug, HelpDocument> = {
  "run-on-your-computer": {
    title: "Run agentes.chat on your computer",
    summary:
      "The agentes.chat app can also run agentes.chat itself, on a Mac or a Linux computer, for you or a small team.",
    sections: [
      {
        id: "how",
        heading: "How it runs",
        blocks: [
          "It runs inside the app, with its own database built in, and keeps everything in one folder on this computer, `~/.agentes`. Nothing else to install: no Docker, no database to set up.",
          "It starts with the app and stops when you quit it. Quitting asks first, because nobody can use agentes.chat until the app opens again.",
        ],
      },
      {
        id: "who",
        heading: "Who it's for",
        blocks: [
          "Made for you or a small team, while this computer is on. For a bigger team, or a server that's always on, install agentes.chat on a server and choose **Connect to my server** in the app. Your data can move there later.",
        ],
      },
      {
        id: "agents",
        heading: "Your agents work here too",
        blocks: [
          "Your agents work on this computer too, in folders of their own, with a browser, and with Claude Code or Codex when they're installed here. Commands stay off until you turn them on in **Preferences\u00a0›\u00a0Tools**.",
        ],
      },
      {
        id: "reach",
        heading: "From your phone and your team",
        blocks: [
          "**Reach it from your phone and teammates** puts agentes.chat on Tailscale, a private network for your devices: your phone and the people you invite join it, and nobody else can reach agentes.chat. Tailscale is free: https://tailscale.com/download. With it off, agentes.chat works only on this computer.",
        ],
      },
      {
        id: "backups",
        heading: "Backups and moving",
        blocks: [
          "**Back up now**, in **Preferences\u00a0›\u00a0Servers**, saves the database, the files and the settings in `~/.agentes/backups`.",
        ],
      },
    ],
  },
  computers: {
    title: "Computers for your agents",
    summary:
      "Agents run code and work with files on computers you connect: a Mac with the agentes.chat app, or a server.",
    sections: [
      {
        id: "mac",
        heading: "A Mac, with the app",
        blocks: [
          "The agentes.chat app opens your server in a window of its own, and with one click its agents work on that Mac, in folders of their own. Install the app, open it, choose **Use your own server\u00a0›\u00a0Connect to my server** and type your server's address. Then, signed in, click **Use this Mac** in **Settings\u00a0›\u00a0Computers**.",
        ],
      },
      {
        id: "server",
        heading: "A server or a Linux computer",
        blocks: [
          "In **Settings\u00a0›\u00a0Computers**, copy the command under **Other ways** and run it in that computer's terminal. It shows a code and a link: open the link, check that the code matches and confirm with your account. There's nothing to install first.",
        ],
      },
      {
        id: "folders",
        heading: "Folders",
        blocks: [
          "Each agent always has its own folder, in `~/agentes/<organization>`. More folders are allowed on the computer itself, never from the website: in the app, **Preferences\u00a0›\u00a0Folders**. Each organization allows its own folders: what you allow for one only counts for its agents. Removing a folder deletes nothing; it only takes the access away.",
        ],
      },
      {
        id: "pausing",
        heading: "Pausing",
        blocks: [
          "Whoever connected a computer can pause its agents on the computer itself, from the app's menu bar. Nothing new starts until they resume; what was running finishes.",
        ],
      },
      {
        id: "organizations",
        heading: "Several organizations",
        blocks: [
          "One computer can work for several organizations. Each one has its own agents, folders and tasks there, and disconnecting one doesn't touch the others.",
        ],
      },
    ],
  },
  "workspace-computer": {
    title: "The workspace's computer",
    summary: "Every workspace gets a computer of its own, always on, where its agents work.",
    sections: [
      {
        id: "what",
        heading: "What it is",
        blocks: [
          "A computer just for this workspace, always on. Each agent has its own user on it, with its own folder, screen, browser and files. From an agent's page you can watch it work, and take control when you need to.",
        ],
      },
      {
        id: "plans",
        heading: "Your AI plans",
        blocks: [
          "Your agents can think with your own AI plan, like Claude, ChatGPT, GLM or Kimi, signed in on this computer: no API key needed. The account stays on this computer, and agentes.chat never sees the password or the access.",
        ],
      },
      {
        id: "size",
        heading: "Its size",
        blocks: ["Its CPUs, memory and disk show in **Settings\u00a0›\u00a0Computers**."],
      },
      {
        id: "trouble",
        heading: "If it stops answering",
        blocks: ["It usually comes back within a few minutes, and we're on it: there's nothing to do on your side."],
      },
    ],
  },
  import: {
    title: "Bring your agents",
    summary:
      "Bring agents from another app, or from another agentes.chat workspace, with their instructions, skills, routines and memory.",
    sections: [
      {
        id: "comes",
        heading: "What comes along",
        blocks: [
          {
            list: [
              "Agents, with their name, role, instructions and look.",
              "Skills. They arrive off: turn on the ones the agents should use right away.",
              "Public channels, with the agents in them.",
              "Routines. They arrive paused: turn them on in **Routines** when you want.",
              "Memory: what each agent remembers.",
            ],
          },
        ],
      },
      {
        id: "never",
        heading: "What never comes along",
        blocks: [
          "Keys, passwords, logins and chat history never come along: the agents use the workspace's model and key. Some things have no equivalent here yet, or should never travel in a file; you can recreate them later.",
          "Files and folders are read in your browser; a GitHub link goes through the workspace's server. Key and login files are never opened, and nothing changes until you confirm.",
        ],
      },
      {
        id: "other-apps",
        heading: "From another app",
        blocks: [
          "Choose **Grok Bot**, **ChatGPT dots** or **Another app**. Copy the request, paste it in that app, then bring back what it returns: drop the file, or paste the whole reply. Where each app puts it:",
          {
            list: [
              "**Grok Bot**: in the chat with your bot. It replies with the JSON: copy the whole reply.",
              "**ChatGPT dots**: in a new chat. Download the file it makes.",
              "**Claude**: in a new conversation, or in your agents' project. Download the file it makes.",
              "**Manus**: in a new task. The file is in the task's results.",
              "**Rakazo**: send it to your agent. It replies with the JSON: copy the whole reply.",
              "**OpenBot**: no request needed. Drag the tenant folder (agents.yaml, agents/, model.yaml, skills.yaml) or paste its GitHub link.",
            ],
          },
        ],
      },
      {
        id: "export",
        heading: "Export a workspace",
        blocks: [
          "**Settings\u00a0›\u00a0Import and export\u00a0›\u00a0Export this workspace** downloads a .json file, to take your agents to another workspace or to keep a copy. In the file:",
          {
            list: [
              "Agents, with their instructions, model and look",
              "Skills, with the whole SKILL.md",
              "Public channels, with their agents",
              "Scheduled routines (they arrive paused on the other side)",
              "The memory everyone in the workspace can see",
            ],
          },
          "Never in it:",
          {
            list: [
              "API keys and passwords",
              "Connectors and logins",
              "Computers",
              "Conversations, messages and private channels",
              "Usage, costs and activity history",
            ],
          },
          "To use the file, open **Settings\u00a0›\u00a0Import and export** in the other workspace and drop the .json.",
        ],
      },
    ],
  },
  wiki: {
    title: "The wiki",
    summary: "What the company knows, in pages linked to each other.",
    sections: [
      {
        id: "links",
        heading: "Links",
        blocks: ["Type [[ to link another page. Backlinks and the graph show how pages connect."],
      },
      {
        id: "agents",
        heading: "How agents use it",
        blocks: ["Agents read the wiki when they answer. They write in it only when someone asks."],
      },
      {
        id: "obsidian",
        heading: "Bring an Obsidian vault",
        blocks: [
          "Drop the vault's folder, or a .zip of it, in the setup's Context step or in the wiki's own import. [[Links]], [[note|alias]] and [[note#section]] keep working. Tags come from the frontmatter and the text. Attachments go to the Drive, and embedded images and files become cards on the page. Callouts stay callouts. Dataview queries come in as text: ask an agent to build the table. Canvases and Obsidian's settings (.obsidian) stay out.",
        ],
      },
    ],
  },
  memory: {
    title: "Memory",
    summary: "What each agent learns from conversations and the team's corrections.",
    sections: [
      {
        id: "learns",
        heading: "How agents learn",
        blocks: [
          "Agents learn from conversations and from the team's corrections. What an agent knows enters its context when relevant. On its **Memory** tab, edit, pin or archive what's wrong or stale.",
        ],
      },
      {
        id: "permissions",
        heading: "Memory grants no permission",
        blocks: [
          "Nothing in memory lets an agent do more. What it can do stays in its **Tools and access**, and sensitive actions always ask for approval.",
        ],
      },
      {
        id: "proposals",
        heading: "Proposed changes",
        blocks: [
          "When a lesson repeats, the agent may propose changing its own instructions or the workspace's context. Nothing changes until someone accepts, and the text can be adjusted first. The previous version stays in the history. A refused proposal is kept as a lesson, so it isn't proposed again.",
        ],
      },
    ],
  },
  approvals: {
    title: "Approvals",
    summary: "Nothing sensitive happens without a person.",
    sections: [
      {
        id: "what",
        heading: "What asks first",
        blocks: [
          "When an agent wants to merge, deploy, roll back, send something outside or delete data, it asks first, whatever access it has. The request shows up in **Approvals** and in the channel, with the exact action and why.",
        ],
      },
      {
        id: "exact",
        heading: "One approval, one action",
        blocks: [
          "Each approval covers one exact action, with its values. If the agent changes anything, it has to ask again.",
        ],
      },
      {
        id: "who",
        heading: "Who approves",
        blocks: ["The agent's owner approves its requests; for an agent without one, the admins do."],
      },
      {
        id: "refusing",
        heading: "Refusing",
        blocks: ["Say why, if you want: the agent reads it, adjusts its plan and keeps it as a lesson."],
      },
      {
        id: "meetings",
        heading: "Meetings",
        blocks: ["Agents only suggest times. Invitations to people always go through whoever asked."],
      },
    ],
  },
};
