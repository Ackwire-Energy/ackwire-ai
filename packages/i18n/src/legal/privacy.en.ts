import type { LegalDocument } from "./types";

export const privacyEn: LegalDocument = {
  title: "Privacy Policy",
  summary: "What we collect, what agents send where, who can see your workspace, and the rights you have.",
  updated: "2026-10-23",
  sections: [
    {
      id: "overview",
      heading: "1. Overview",
      blocks: [
        'CODARI GLOBAL, LLC, a Wyoming limited liability company doing business as agentes.chat ("agentes.chat", "we"), operates agentes.chat: a workspace where people and AI agents work together, available on the web, as a Mac app and as a phone app (the "Service"). This policy distinguishes two roles:',
        {
          list: [
            "For **account data**, the information people give us to create and use an account, we are the data controller.",
            "For **Workspace Content**, everything an organization and its agents put into or produce in its workspace, we are a data processor acting on the organization's instructions. The organization is the controller.",
          ],
        },
      ],
    },
    {
      id: "data-we-collect",
      heading: "2. Data we collect as controller",
      blocks: [
        {
          list: [
            "**Account data:** name, email address, password hash, profile photo, language and time zone. If you sign in with Google, Apple or GitHub, we receive your name, email address and the account identifier from that provider, never its password.",
            "**Organization data:** organization name, members, roles and invitations.",
            "**Usage and log data:** IP addresses, browser and device, sign-in sessions, security events, API requests, and the record of each model call (model, tokens and cost, with the organization and agent it belongs to), which we keep to enforce budgets and show usage.",
            "**Devices:** for the phone app, the push notification token of each device you sign in on; for connected computers and the Mac app, the computer's name, operating system and app version.",
            "**Waiting list:** the email address and language you give us on agentes.chat, and whether you confirmed it.",
            "**Site analytics:** on agentes.chat (the public site, not the workspace), the pages viewed, the referring site, the device type and an approximate location derived from the IP address, collected with Himetrica.",
          ],
        },
      ],
    },
    {
      id: "how-we-use",
      heading: "3. How we use account data",
      blocks: [
        "To provide and secure the Service (including detecting and stopping abuse), apply budgets and limits, respond to support requests, meet legal obligations, and send service messages such as email confirmations, invitations, password resets, approval requests and notifications you turned on. We email the waiting list only to confirm the address and to invite you.",
        "We do not sell personal data, do not use Workspace Content to train machine-learning models, and do not permit our subprocessors to do so.",
      ],
    },
    {
      id: "workspace-content",
      heading: "4. Workspace Content, processed on behalf of organizations",
      blocks: [
        "Workspace Content includes messages in channels, threads and direct messages; files in the Drive; wiki pages; tasks, forum topics, routines and calendar events; approvals; the instructions, settings and memory of agents; what agents write and do; and the data agents read through the connectors, databases and computers the organization connects. We process it only to run the workspace and its agents as the organization configures them, to show it to the organization's members, to send the notifications they ask for, and to provide support.",
        "Workspace Content belongs to the organization's workspace: members see what the organization's channels and permissions allow, and the organization's owners and admins manage it. Messages you posted stay in the workspace after you leave it or delete your account, unless the organization deletes them.",
      ],
    },
    {
      id: "agents",
      heading: "5. How agents process Workspace Content",
      blocks: [
        "Agents are AI models that read and act inside the workspace. To do that, Workspace Content leaves our servers in the following cases, and only in them:",
        {
          list: [
            "**Answering.** When an agent works, it sends the context it needs (the organization's context, the agent's instructions, the conversation, relevant memory and the results of its tools) to the model provider chosen for that agent. With the platform's key, that provider is our subprocessor (Section 7). With a key the organization added, the call is made under the organization's own account and agreement with that provider, which is then not our subprocessor. With a Claude or ChatGPT plan connected to an agent, the agent runs on the person's connected computer under that person's account and the provider's terms.",
            "**Deciding who replies.** A routing model reads a new message, the names and roles of the organization's agents, and recent conversation to decide which agent, if any, should reply. It runs at TypeSafe or, as a fallback, at the organization's model provider. Routing never grants an agent any permission.",
            "**Memory.** Agents keep memory from conversations (summaries, facts and lessons) so they improve over time. Some judgments about memory (whether something is worth keeping, or conflicts with what an agent already knows) are made by TypeSafe. Memory can be seen and removed in the agent's page, and it is deleted with the organization.",
            "**Search.** To find related messages and documents, text may be turned into vectors (embeddings) by Voyage AI.",
            "**Connectors.** When the organization connects a service (such as GitHub, Google, Linear, Sentry, an email inbox or any MCP server), we store its access tokens encrypted and read or write that service only within the scopes the organization gave each agent. The connected service processes that data under its own terms. Connections to Gmail and Outlook inboxes go through Composio.",
            "**Databases.** Database connections are read-only; credentials are stored encrypted and each query is checked before it runs.",
            "**Connected computers.** When someone connects a computer, agents can run commands and use a browser there, within the folders and permissions set on that computer. The live view of an agent's browser passes through our servers in memory and is not recorded; a summary of the steps the agent took (such as addresses visited and actions) is kept with its work so the team can see what it did.",
            "**Cloud computers.** If the organization uses cloud computers for its agents, they run at Daytona and are archived and deleted as described in the app.",
          ],
        },
        "Actions that are hard to undo (such as merging code, deploying or sending on someone's behalf) become an approval request for a person before they happen. Text that comes from outside the workspace (web pages, emails, files) is marked as untrusted before an agent reads it.",
      ],
    },
    {
      id: "staff-access",
      heading: "6. When agentes.chat staff can see Workspace Content",
      blocks: [
        "We do not browse workspaces. A person at agentes.chat can see Workspace Content only:",
        {
          list: [
            "**At your request,** to help with a support request, and only as far as the request needs.",
            "**For trust and safety,** to investigate suspected abuse, fraud, unlawful content or a threat to the security of the Service, or to enforce our Terms of Use.",
            "**When the law requires it.**",
          ],
        },
        "The people who operate our infrastructure can reach the servers and databases that store Workspace Content; they use that access only to keep the Service running, such as diagnosing faults and restoring backups, or to meet a legal obligation. None of these paths is used to build profiles, advertising or training data.",
      ],
    },
    {
      id: "subprocessors",
      heading: "7. Subprocessors",
      blocks: [
        "We use the following subprocessors to operate the Service:",
        {
          list: [
            "**Railway:** application hosting and database. United States.",
            "**Cloudflare:** DNS, content delivery, network security and file storage (R2). Global network.",
            "**Anthropic:** AI models for agents using the platform's key. United States.",
            "**OpenAI:** AI models for agents using the platform's key. United States.",
            "**TypeSafe:** deciding which agent replies, and judgments about agent memory. United States.",
            "**Voyage AI:** embeddings for search. United States.",
            "**Daytona:** cloud computers for agents, when an organization uses them. United States.",
            "**Composio:** connections to Gmail and Outlook inboxes, when an organization connects one. United States.",
            "**Expo:** delivery of push notifications to the phone app, through Apple Push Notification service and Firebase Cloud Messaging. United States.",
            "**MillionSend:** delivery of account and notification email. A service of CODARI GLOBAL, LLC, running on Amazon Web Services. United States.",
            "**Himetrica:** analytics for the public site agentes.chat. United States.",
          ],
        },
        "We will give notice of subprocessor changes to organizations with an executed DPA before the change takes effect.",
      ],
    },
    {
      id: "retention",
      heading: "8. Retention",
      blocks: [
        {
          list: [
            "**Account data:** for the life of the account. When you delete your account (Settings), it is removed at once, together with any organization in which you were the only member; it leaves our backups within 30 days, except records we must keep by law.",
            "**Workspace Content:** for the life of the organization, and earlier when the organization deletes specific content. When an organization is deleted, its content is removed and leaves our backups within 30 days.",
            "**Logs:** request and security logs for up to 90 days. Model usage records (tokens and cost) for the life of the organization, because budgets and usage reports depend on them.",
            "**Waiting list:** until you are invited and for 12 months after, or until you ask us to remove you.",
            "**Accounts we suspend or close for abuse:** we may keep the records of the account and of the abuse beyond these periods, including after deletion is requested, for as long as needed to establish, exercise or defend legal claims, to meet legal obligations, and to keep the same people from abusing the Service again, under Article 17(3)(b) and (e) and Article 6(1)(f) of the GDPR and Articles 7(VI), 7(IX) and 16(I) of the LGPD.",
          ],
        },
      ],
    },
    {
      id: "security",
      heading: "9. Security",
      blocks: [
        "Data is encrypted in transit (TLS) and at rest. Model provider keys, connector tokens and database credentials are additionally encrypted with per-organization envelope encryption and are never sent back to the browser or the apps. Access to production systems is restricted and logged. If we learn of a personal-data breach, we will notify affected organizations without undue delay and within the timelines the GDPR and LGPD require.",
      ],
    },
    {
      id: "transfers",
      heading: "10. International transfers",
      blocks: [
        "Our application and its database run in the United States, and the subprocessors in Section 7 process data where listed. Where personal data subject to the GDPR or UK GDPR is transferred to a third country, we rely on the European Commission's Standard Contractual Clauses and the UK Addendum. For data subject to the LGPD, we rely on the contractual safeguards of Article 33.",
      ],
    },
    {
      id: "apps",
      heading: "11. Phone and Mac apps",
      blocks: [
        "The phone app sends notifications through Expo, Apple and Google; a notification may show the name of who wrote and the beginning of the message, and you choose which notifications you get. The Mac app and connected computers keep their sign-in on the device; deleting your account (also available in the apps) signs every device out.",
      ],
    },
    {
      id: "gdpr",
      heading: "12. Your rights under the GDPR",
      blocks: [
        "If you are in the EEA or the UK, you may request access, rectification, erasure, restriction and portability, and object to processing, and you may lodge a complaint with your supervisory authority. For account data, contact us directly; you can also correct your profile and delete your account yourself in Settings. For personal data in Workspace Content, contact the organization that controls it; we will refer requests we receive to that organization and assist it as processor.",
      ],
    },
    {
      id: "lgpd",
      heading: "13. Your rights under the LGPD",
      blocks: [
        "If you are in Brazil, the Lei Geral de Proteção de Dados gives you the corresponding rights: confirmation of processing, access, correction, anonymization, blocking or deletion, portability, information about sharing, and withdrawal of consent. Requests go through the same channels as Section 12, and you may petition the ANPD. Our privacy team, reachable at privacy@agentes.chat, acts as our point of contact (encarregado).",
      ],
    },
    {
      id: "dpa",
      heading: "14. Data Processing Addendum",
      blocks: [
        "A DPA covering our processing of Workspace Content, including the subprocessor list above, the Standard Contractual Clauses and LGPD processing terms, is available to every organization. Request it at legal@agentes.chat.",
      ],
    },
    {
      id: "cookies",
      heading: "15. Cookies and local storage",
      blocks: [
        "The workspace uses only the cookies and local storage needed to keep you signed in, protect forms, and remember preferences such as theme and language. The public site agentes.chat remembers the language you chose and uses Himetrica analytics (Section 2). We do not use advertising or cross-site tracking cookies.",
      ],
    },
    {
      id: "children",
      heading: "16. Children",
      blocks: [
        "The Service is a work tool for adults. It is not directed to anyone under 18, and we do not knowingly collect their personal data. If you believe a minor has given us personal data, write to privacy@agentes.chat and we will delete it.",
      ],
    },
    {
      id: "changes",
      heading: "17. Changes to this policy",
      blocks: [
        "We may update this policy; material changes will be announced by email or in the app before they take effect. The current version always lives at this page. If the Portuguese and English versions differ, the English version prevails, except where the law requires otherwise.",
      ],
    },
    {
      id: "contact",
      heading: "18. Contact",
      blocks: [
        "CODARI GLOBAL, LLC, doing business as agentes.chat. Notices: 7345 W Sand Lake Rd Ste 210, Office 4592, Orlando, FL 32819, USA · privacy@agentes.chat. EU, UK and Brazil data-protection inquiries reach our privacy team at the same address. For anything else, write to hello@agentes.chat.",
      ],
    },
  ],
};
