import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

export const helpEn: Record<HelpSlug, HelpDocument> = {
  "run-on-your-computer": {
    title: "Run agentes.chat on your computer",
    summary:
      "The agentes.chat app can also run agentes.chat itself, on a Mac, a PC or a Linux computer, for you or a small team.",
    sections: [
      {
        id: "how",
        heading: "How it runs",
        blocks: [
          "It runs inside the app, with its own database built in, and keeps everything in one folder on this computer, `.agentes` in your home folder. Nothing else to install: no Docker, no database to set up.",
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
          "**Back up now**, in **Preferences\u00a0›\u00a0Servers**, saves the database, the files and the settings in `.agentes/backups`, in your home folder.",
        ],
      },
    ],
  },
  computers: {
    title: "Computers for your agents",
    summary:
      "Agents run code and work with files on computers you connect: a Mac or a PC with the agentes.chat app, or a server.",
    sections: [
      {
        id: "mac",
        heading: "A Mac or a PC, with the app",
        blocks: [
          "The agentes.chat app opens your server in a window of its own, and with one click its agents work on that computer, in folders of their own. Install the app, open it, choose **Use your own server\u00a0›\u00a0Connect to my server** and type your server's address. Then, signed in, click **Use this Mac** (**Use this PC** on Windows, **Use this computer** on Linux) in **Settings\u00a0›\u00a0Computers**.",
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
          "Each agent always has its own folder, in `~/agentes/<workspace>`. More folders are allowed on the computer itself, never from the website: in the app, **Preferences\u00a0›\u00a0Folders**, or with `agentes-runner folders allow` on a server. Each workspace allows its own folders: what you allow for one only counts for its agents. Removing a folder deletes nothing. It only takes the access away.",
        ],
      },
      {
        id: "pausing",
        heading: "Pausing",
        blocks: [
          "With the app, whoever connected a computer can pause its agents there, from the agentes.chat icon by the clock. Nothing new starts until they resume. What was running finishes.",
        ],
      },
      {
        id: "organizations",
        heading: "Several workspaces",
        blocks: [
          "One computer can work for several workspaces. Each one has its own agents, folders and tasks there, and disconnecting one doesn't touch the others.",
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
          "Google's AI Pro and Ultra plans don't work here: Google's terms don't allow them in other products. A Gemini API key does.",
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
              "Each agent's own files (OpenBot.run's files folder, an OpenClaw workspace), in a folder with its name in the **Drive**. Keys, logins and system files stay behind, and nothing already there is replaced.",
            ],
          },
        ],
      },
      {
        id: "never",
        heading: "What never comes along",
        blocks: [
          "Keys, passwords, logins and chat history never come along: the agents think with the workspace's AI. Some things have no equivalent here yet, or should never travel in a file. You can recreate them later.",
          "Files and folders are read in your browser. A GitHub link goes through the workspace's server. Key and login files are never opened, and nothing changes until you confirm.",
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
          "**Settings\u00a0›\u00a0Import and export\u00a0›\u00a0Export** downloads a .json file, to take your agents to another workspace or to keep a copy. In the file:",
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
        blocks: ["The agent's owner approves its requests. For an agent without an owner, the admins do."],
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
  "who-answers": {
    title: "Who answers a message",
    summary: "A mention picks the agent. Without one, agentes.chat picks for you, in this order.",
    sections: [
      {
        id: "order",
        heading: "How a message finds its agent",
        blocks: [
          "A message that @mentions an agent goes to that agent. A message that mentions nobody is read by the first of these the workspace has:",
          {
            list: [
              "**Jev**, a small, fast model made for decisions like this one.",
              "**A small model on one of the workspace's API keys**, such as Claude Haiku 5.5 or GPT-6 Luna.",
              "**Your own Claude or ChatGPT plan**, for the messages you write, on a server you run yourself. It reads them on the computer where it's signed in, and takes a few seconds.",
              "**Simple rules**: a reply to an agent goes to it, and so does a follow-up right after you talked with it, or a message in a channel where you are alone with one agent.",
            ],
          },
          "When none of these fits, no agent answers. Mention an agent to call it.",
        ],
      },
      {
        id: "jev",
        heading: "Jev",
        blocks: [
          "When agentes.chat hosts your workspace, Jev is included. On a server you run yourself, it uses the owner's TypeSafe key, about US$ 0.0001 a message: [Set up Jev](/help/jev#setup).",
        ],
      },
      {
        id: "plans",
        heading: "Why your plan picks only for your messages",
        blocks: ["Claude and ChatGPT plans are personal, so your plan picks only for the messages you write."],
      },
      {
        id: "see",
        heading: "Seeing who picked",
        blocks: ["Open the check under a message. Its last line says who picked the agents."],
      },
    ],
  },
  jev: {
    title: "Jev",
    summary:
      "A fast model by TypeSafe that makes quick decisions for your agents. On your own server it's optional, with a key of your own.",
    sections: [
      {
        id: "what",
        heading: "What it does",
        blocks: [
          {
            list: [
              "**Picks who answers.** A message nobody @mentioned goes to the right agent in under a second, even when your agents think with a plan and you have no API key.",
              "**Keeps memory tidy.** It spots a repeat or a newer fact even in other words: the repeat merges with what the agent knew, and the newer fact replaces the old one. Once a day it tidies the rest.",
              "**Sees the screen.** On their browser and desktop, agents find buttons and fields from a description, look closer at small ones, and check on the screen's image that a step worked.",
              "**Reads less.** Each turn loads only the tools the agent will likely need, so your AI reads less and costs less.",
            ],
          },
        ],
      },
      {
        id: "without",
        heading: "Without it",
        blocks: [
          "Everything keeps working, more slowly and with less care.",
          {
            list: [
              "**Who answers:** a small model on one of your API keys picks, such as Claude Haiku 5.5 or GPT-6 Luna. Without a key, each person's own Claude or ChatGPT plan picks for the messages they write, in a few seconds. Otherwise a reply or a follow-up still reaches its agent. Mention an agent to call it. [How agents are picked](/help/who-answers)",
              "**Memory:** repeats in the same words still merge. Repeats and updates in other words stay apart.",
              "**Screen:** agents use the numbers shown on the screen and exact names. Nothing is read from images.",
            ],
          },
        ],
      },
      {
        id: "setup",
        heading: "Set it up",
        blocks: [
          {
            list: [
              "Open https://console.typesafe.ai and sign in with Google or your email. A new account is made the same way.",
              "Add credit in the console. Jev is prepaid.",
              "Open https://console.typesafe.ai/keys, create a key and copy it right away.",
              "In agentes.chat, open **Settings\u00a0›\u00a0AI accounts** and paste it under **Jev**. Only the person who set up this server sees it.",
            ],
          },
          "On a server you run with Docker, you can put the key in `.env` as `TYPESAFE_API_KEY` instead. That one wins over the one in Settings.",
        ],
      },
      {
        id: "cost",
        heading: "What it costs",
        blocks: [
          {
            list: [
              "US$ 0.042 per million tokens Jev reads. Its answers are free. Picking who answers reads about 2,500 tokens, so about US$ 0.0001. A screenshot is about 3,900 tokens.",
              "Credits you buy last 12 months. Turn on automatic refills in the console so Jev doesn't run out.",
              "**Settings\u00a0›\u00a0AI accounts** shows how many decisions Jev made this month, and what they cost.",
            ],
          },
        ],
      },
      {
        id: "data",
        heading: "Your data",
        blocks: [
          "What Jev reads to decide:",
          {
            list: [
              "The channel's name and description, the message and the few before it",
              "Your agents' names and roles, the start of their instructions and the tools they can use",
              "The memory items it compares",
              "An agent's task and the start of its tool results",
              "A mission's goal and the commands an agent wants to run for it",
              "The tools a connected app offers",
              "The page or screen an agent is using, screenshots included",
            ],
          },
          "TypeSafe runs Jev in the United States and doesn't train its models on what you send. It keeps data as long as it needs to run the service. Zero retention is available on its enterprise plans.",
          "TypeSafe's privacy policy: https://typesafe.ai/legal/privacy-policy. Its data processing agreement: https://typesafe.ai/legal/data-processing.",
        ],
      },
      {
        id: "problems",
        heading: "When it stops",
        blocks: [
          {
            list: [
              "**Key not accepted:** create a new key and paste it in **Settings\u00a0›\u00a0AI accounts**.",
              "**Out of credit:** add credit in the console. Jev tries again within 30 minutes, or click **Check again**.",
              "**Busy or unreachable:** TypeSafe may limit requests per second, or stop answering for a while. Jev picks up again by itself. Your limits: https://console.typesafe.ai/rate-limits. For higher ones, write to sales@typesafe.ai.",
            ],
          },
          "Meanwhile, agents work as in [Without it](/help/jev#without).",
        ],
      },
    ],
  },
  "apps-de-ia": {
    title: "AI apps",
    summary:
      "Ask agentes.chat's agents for tasks from Claude, ChatGPT, Cursor or another MCP app, without leaving it, and get the answer right there.",
    sections: [
      {
        id: "what",
        heading: "How it works",
        blocks: [
          "agentes.chat is an MCP server. You paste its address into your AI app, sign in with your account and pick a workspace. From then on, the app can list agents and channels, send a task to an agent as you, wait for the reply and read recent tasks.",
          'For example, in the middle of a scene in Unity or Blender, ask Claude: "Ask the marketing agent for a launch blurb". The message shows in agentes.chat as yours, marked **via Claude**, and the agent\'s reply comes back to Claude.',
          "The address is in **Settings\u00a0›\u00a0AI apps**. It ends in `/mcp`.",
        ],
      },
      {
        id: "connect",
        heading: "Connect an app",
        blocks: [
          {
            list: [
              "**Claude** (claude.ai, Claude Desktop and phone): Settings\u00a0›\u00a0Connectors, **Add custom connector**, paste the address and click **Connect**. On Team and Enterprise plans, a Claude admin adds the connector first.",
              "**Claude Code:** run `claude mcp add --transport http agentes <address>`, then type `/mcp`, pick agentes and **Authenticate**. Add `--scope user` to use it in every project.",
              "**ChatGPT** (paid plans): on chatgpt.com/plugins, click **+** and **Add custom MCP server**, and paste the address.",
              "**Cursor:** **Add to Cursor** in **Settings\u00a0›\u00a0AI apps**, or the address in `~/.cursor/mcp.json`. Cursor asks you to sign in the first time you use it.",
              '**VS Code:** **Add to VS Code**, or the address in `.vscode/mcp.json` with `"type": "http"`.',
              "**Codex:** run `codex mcp add agentes --url <address>`, then `codex mcp login agentes`.",
            ],
          },
          "When you sign in, agentes.chat shows which app asked for access and where it returns to. Continue only if you just started the connection.",
        ],
      },
      {
        id: "tools",
        heading: "What the app can do",
        blocks: [
          {
            list: [
              "`send_to_agent`: sends a message from you to an agent, in your private conversation with it or in a channel, and waits for the reply. Only with **Read and send tasks to agents** access.",
              "`wait_for_reply`: keeps waiting for a task's reply.",
              "`list_agents`: the agents you see.",
              "`list_channels`: the channels you read.",
              "`read_conversation`: recent messages of a channel, a thread or a task.",
              "`list_recent_tasks`: the tasks you sent from apps and what agents are doing now.",
            ],
          },
          "The app acts as you and sees only what you see. It never approves agents' actions: when an agent stops to ask for approval, the reply says so with a link, and a person decides in agentes.chat. It doesn't change settings, members or permissions either.",
        ],
      },
      {
        id: "workspace",
        heading: "One workspace per connection",
        blocks: [
          "Each connection covers the workspace picked when signing in. To use another workspace, connect the app again and pick the other one.",
          "In **Settings\u00a0›\u00a0AI apps** you see the connected apps, when each was used, and disconnect any of them. People who manage members see the whole workspace's apps and can disconnect them too. Every message sent from an app shows in the Audit.",
        ],
      },
      {
        id: "tokens",
        heading: "Personal tokens",
        blocks: [
          "For scripts and apps without OAuth sign-in, create a personal token in **Settings\u00a0›\u00a0AI apps** and send it in the `Authorization: Bearer` header. The token is shown once, works only in the workspace it was created in, and can expire in 30 days, 90 days, 1 year or never.",
          "On a server without https, away from its own computer, use a personal token: OAuth sign-in needs https.",
        ],
      },
      {
        id: "limits",
        heading: "Limits",
        blocks: [
          {
            list: [
              "Up to 120 requests a minute and 5,000 a day per connection.",
              "Up to 20 messages a minute and 500 a day per person in each workspace.",
              "A wait lasts up to 45 seconds. When the agent is still working, the app waits again.",
            ],
          },
        ],
      },
      {
        id: "safety",
        heading: "Other people's text",
        blocks: [
          "Replies carry text written by agents and people in agentes.chat. The app gets that text marked as content, not instructions, but a text may still try to talk the app into something else. Check what your app is about to do before you confirm.",
        ],
      },
      {
        id: "problems",
        heading: "When it won't connect",
        blocks: [
          {
            list: [
              "**Request expired:** the sign-in page lasts 30 minutes and works once. Go back to the app and connect again.",
              "**The app asks to sign in again:** the connection was disconnected, the password changed or you left the workspace. Sign in again from the app.",
              "**Cursor stuck on an old sign-in:** quit Cursor, delete the `~/.mcp-auth` folder and connect again.",
            ],
          },
        ],
      },
    ],
  },
};
