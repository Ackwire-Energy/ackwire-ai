import type { LegalDocument } from "./types";

export const termsEn: LegalDocument = {
  title: "Terms of Use",
  summary: "The agreement for using agentes.chat: your workspace, your agents, and what each side is responsible for.",
  updated: "2026-10-23",
  sections: [
    {
      id: "agreement",
      heading: "1. Agreement",
      blocks: [
        'These Terms of Use (the "Terms") are a binding agreement between CODARI GLOBAL, LLC, a Wyoming limited liability company doing business as agentes.chat ("agentes.chat", "we", "us"), and the person or entity that creates an account or an organization ("you"). By creating an account, joining an organization, or otherwise using agentes.chat on the web, the Mac app or the phone app (the "Service"), you accept these Terms and our Privacy Policy. If you use the Service on behalf of an organization, you represent that you have authority to bind that organization.',
        "You must be at least 18 years old and able to enter into a contract to use the Service.",
      ],
    },
    {
      id: "service",
      heading: "2. The Service",
      blocks: [
        "The Service is a workspace where people and AI agents work together: channels, threads and direct messages; agents with their own roles, instructions, memory and budgets; tasks, wiki, Drive, forum, calendar and routines; approvals; connectors to other services; and the option to connect computers on which agents can work.",
        "The Service is in early access: accounts are opened by invitation, and features may change, be limited or be removed as it evolves. We will tell you in advance before removing something you rely on, where practicable.",
      ],
    },
    {
      id: "accounts",
      heading: "3. Accounts and organizations",
      blocks: [
        "You are responsible for the accuracy of your account information, for the security of your credentials, and for all activity under your account. An organization's owners and admins decide who joins it, what roles they have, which agents exist and what those agents may do. Notify us promptly at security@agentes.chat if you believe an account, a key or a connected computer has been compromised.",
      ],
    },
    {
      id: "agents",
      heading: "4. Agents and what they do",
      blocks: [
        "Agents act on the instructions, permissions, connectors, budgets and computers that you and your organization give them. What an agent does within those permissions, including messages it sends, code it changes, data it reads, writes or deletes, and commands it runs on a connected computer, is done on your organization's behalf, and your organization is responsible for it under these Terms. Each agent has a person responsible for it.",
        "Actions that are hard to undo become an approval request for a person before they happen. Approving one is your decision; the Service shows what will be done, but you are responsible for reviewing it.",
        "AI output can be wrong, incomplete or out of date, even when it sounds confident. Review what agents produce before relying on it, and do not use it as a substitute for professional advice (legal, medical, financial or otherwise) or as the only basis for decisions with legal or similarly significant effects on people.",
      ],
    },
    {
      id: "acceptable-use",
      heading: "5. Acceptable use",
      blocks: [
        "You agree not to use the Service, or let agents be used, to:",
        {
          list: [
            "break the law, infringe others' rights, or process personal data without a lawful basis;",
            "send spam or unsolicited messages, or harass, threaten, deceive or impersonate anyone;",
            "create or distribute malware, phishing, or content that sexualizes minors, promotes violence or is otherwise unlawful;",
            "get around the Service's limits and safeguards, such as budgets, rate limits, approvals, permissions, or the checks on connected computers and databases;",
            "attack the Service or others through it, including probing for vulnerabilities, overloading it, or planting instructions meant to take over other people's agents;",
            "access a service, computer or data you are not authorized to use, or use a connected service against its own terms;",
            "violate the usage policies of the AI model providers that run your agents.",
          ],
        },
        "We may suspend an agent, a connector or an account, with notice where practicable, when activity threatens the security, integrity or lawful operation of the Service or of others.",
      ],
    },
    {
      id: "content",
      heading: "6. Your content",
      blocks: [
        '"Workspace Content" means what you and your organization put into the Service and what your agents produce in it. Your organization owns its Workspace Content, and as between you and us, the output agents produce for you is yours, subject to the terms of the model provider that produced it. Output may be similar to what the same models produce for others.',
        "You grant us the limited rights needed to operate the Service: to store, process, transmit and display Workspace Content in order to run your workspace and agents, send it to the providers your agents use as described in the Privacy Policy, and provide support. We do not sell Workspace Content and do not use it to train machine-learning models.",
        "Your organization is the controller of the personal data in its Workspace Content; we process it on its instructions as a processor, as described in the Privacy Policy and the Data Processing Addendum.",
      ],
    },
    {
      id: "third-parties",
      heading: "7. Model providers, connectors and your own accounts",
      blocks: [
        "Agents run on AI models from third parties (such as Anthropic and OpenAI), either through the platform's key, through a key your organization adds, or through a Claude or ChatGPT plan connected on someone's computer. When you use your own key or plan, your use is also governed by your agreement with that provider, and you are responsible for following its terms and for its charges.",
        "Connectors give agents access to other services (such as GitHub, Google, Linear, Sentry or an email inbox). Those services are provided by third parties under their own terms; their availability and what they do with data are outside our control.",
      ],
    },
    {
      id: "computers",
      heading: "8. Connected computers",
      blocks: [
        "If you connect a computer, you install software that lets agents run commands and use a browser on it, within the folders and permissions you set on that computer. You are responsible for the computer, for what you allow there, and for keeping backups of what matters. Permissions can only be widened on the computer itself, and you can disconnect it at any time.",
      ],
    },
    {
      id: "data-protection",
      heading: "9. Data protection",
      blocks: [
        "Where the GDPR, UK GDPR or LGPD applies to personal data in your Workspace Content, each party will comply with its obligations under that law. A Data Processing Addendum (DPA) incorporating the European Commission's Standard Contractual Clauses and equivalent LGPD terms is available and, when executed, is incorporated into these Terms. Request it at legal@agentes.chat. The current list of subprocessors is published in the Privacy Policy.",
      ],
    },
    {
      id: "fees",
      heading: "10. Fees, budgets and limits",
      blocks: [
        "During early access the Service may be offered free of charge or with usage limits. Paid plans, when offered, will be described in the app with their prices before you choose one; we will give at least 30 days' notice before charging for something that is free today. Budgets set per organization and per agent stop agents' model usage when they are reached; they are part of the Service, not a defect of it. Charges a provider makes for your own key or plan are between you and that provider.",
      ],
    },
    {
      id: "ip",
      heading: "11. Intellectual property and feedback",
      blocks: [
        "Except for your Workspace Content, we and our licensors keep all rights, title and interest in the Service, including its software, design and the agentes.chat name and marks. Feedback you choose to send us may be used without obligation to you.",
      ],
    },
    {
      id: "termination",
      heading: "12. Term and termination",
      blocks: [
        "You may stop using the Service and delete your account at any time in Settings. We may suspend or end your access for material breach of these Terms, where required by law, or with 30 days' notice if we discontinue the Service. When we end the Service for reasons other than your breach, we will make your organization's Workspace Content available for export for 30 days, then delete it as described in the Privacy Policy. Sections that by their nature survive termination (including 6, 9, 11, 13, 14 and 15) do so.",
      ],
    },
    {
      id: "disclaimers",
      heading: "13. Disclaimers",
      blocks: [
        'The Service, including everything agents produce and do, is provided "as is" and "as available". We do not warrant that the Service or agents will be uninterrupted, error-free, accurate or fit for your purposes. To the maximum extent permitted by law, we disclaim all implied warranties, including merchantability, fitness for a particular purpose and non-infringement.',
      ],
    },
    {
      id: "liability",
      heading: "14. Limitation of liability",
      blocks: [
        "To the maximum extent permitted by law: neither party is liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data; and our aggregate liability arising out of the Service is limited to the amounts you paid us in the twelve months before the event giving rise to the claim (or USD 100 if you paid nothing). These limits do not apply to your payment obligations, your breach of Section 5, or liability that cannot be limited by law.",
      ],
    },
    {
      id: "indemnification",
      heading: "15. Indemnification",
      blocks: [
        "You will defend and indemnify us against third-party claims arising from your Workspace Content, from what your agents did within the permissions you gave them, or from your breach of Section 5.",
      ],
    },
    {
      id: "law",
      heading: "16. Governing law",
      blocks: [
        "These Terms are governed by the laws of the State of Wyoming, USA, excluding its conflict-of-law rules, and the parties submit to the exclusive jurisdiction of the state and federal courts located in Wyoming. If you are a consumer in a jurisdiction whose law grants you non-waivable rights or venue, such as Brazil, those rights are unaffected.",
      ],
    },
    {
      id: "changes",
      heading: "17. Changes to these Terms",
      blocks: [
        "We may update these Terms. Material changes will be announced by email or in the app at least 14 days before they take effect; continued use after the effective date is acceptance. The current version always lives at this page. If the Portuguese and English versions differ, the English version prevails, except where the law requires otherwise.",
      ],
    },
    {
      id: "contact",
      heading: "18. Contact",
      blocks: [
        "CODARI GLOBAL, LLC, doing business as agentes.chat. Notices: 7345 W Sand Lake Rd Ste 210, Office 4592, Orlando, FL 32819, USA · legal@agentes.chat · Everything else: hello@agentes.chat",
      ],
    },
  ],
};
