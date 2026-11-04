import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

/** The help pages in zh-Hans: a page not here shows in English. */
export const helpZhHans: Partial<Record<HelpSlug, HelpDocument>> = {
  "run-on-your-computer": {
    title: "在你的电脑上运行 agentes.chat",
    summary: "agentes.chat 应用也可以在 Mac、PC 或 Linux 电脑上直接运行 agentes.chat，供你自己或小团队使用。",
    sections: [
      {
        id: "how",
        heading: "运行方式",
        blocks: [
          "它在应用内运行，自带数据库，所有内容都保存在这台电脑的一个文件夹里，也就是你主文件夹中的 `.agentes`。无需安装其他东西：不用 Docker，也不用配置数据库。",
          "它随应用启动，退出应用时停止。退出前会先询问你，因为在应用重新打开之前，谁都无法使用 agentes.chat。",
        ],
      },
      {
        id: "who",
        heading: "适合谁",
        blocks: [
          "适合你自己或小团队在这台电脑开机时使用。如果团队更大，或需要一台始终在线的服务器，请[把 agentes.chat 安装到服务器上](/help/install-on-a-server)，然后在应用中选择 **连接到我的服务器**。你的数据之后可以迁移过去。",
        ],
      },
      {
        id: "agents",
        heading: "你的智能体也在这里工作",
        blocks: [
          "你的智能体也在这台电脑上工作，各自有自己的文件夹和浏览器，如果这里装了 Claude Code 或 Codex，它们也能使用。在 **偏好设置 › 工具** 中开启之前，命令一直处于关闭状态。",
        ],
      },
      {
        id: "reach",
        heading: "从手机和团队访问",
        blocks: [
          "**允许从手机和队友访问** 会把 agentes.chat 接入 Tailscale，一个连接你各台设备的私有网络：你的手机和你邀请的人可以加入，其他人都无法访问 agentes.chat。Tailscale 是免费的：https://tailscale.com/download 。关闭这个选项时，agentes.chat 只能在这台电脑上使用。",
        ],
      },
      {
        id: "backups",
        heading: "备份和迁移",
        blocks: [
          "**偏好设置 › 服务器** 中的 **立即备份** 会把数据库、文件和设置保存到你主文件夹的 `.agentes/backups` 中。",
        ],
      },
    ],
  },
  computers: {
    title: "给智能体用的电脑",
    summary: "智能体在你连接的电脑上运行代码、处理文件：可以是装有 agentes.chat 应用的 Mac 或 PC，也可以是服务器。",
    sections: [
      {
        id: "mac",
        heading: "装有应用的 Mac 或 PC",
        blocks: [
          "agentes.chat 应用会在独立窗口中打开你的服务器，点一下，它的智能体就能在这台电脑上各自的文件夹里工作。安装并打开应用，选择 **使用你自己的服务器 › 连接到我的服务器**，然后输入服务器地址。登录后，在 **设置 › 电脑** 中点 **使用这台 Mac**（Windows 上是 **使用这台 PC**，Linux 上是 **使用这台电脑**）。",
        ],
      },
      {
        id: "server",
        heading: "服务器或 Linux 电脑",
        blocks: [
          "在 **设置 › 电脑** 中，复制 **其他方式** 下的命令，在那台电脑的终端里运行。它会显示一个代码和一个链接：打开链接，核对代码一致，然后用你的账号确认。无需事先安装任何东西。",
        ],
      },
      {
        id: "folders",
        heading: "文件夹",
        blocks: [
          "每个智能体始终有自己的文件夹，位于 `~/agentes/<workspace>`。更多文件夹只能在电脑本机上授权，网页上不行：在应用的 **偏好设置 › 文件夹** 中，或在服务器上用 `agentes-runner folders allow`。每个工作区单独授权自己的文件夹：你为一个工作区授权的文件夹，只对它的智能体有效。移除文件夹不会删除任何内容，只是收回访问权限。",
        ],
      },
      {
        id: "pausing",
        heading: "暂停",
        blocks: [
          "使用应用时，连接这台电脑的人可以通过时钟旁的 agentes.chat 图标，暂停在这台电脑上工作的智能体。恢复之前不会开始任何新工作，正在运行的会照常完成。",
        ],
      },
      {
        id: "organizations",
        heading: "多个工作区",
        blocks: [
          "一台电脑可以同时为多个工作区工作。每个工作区在上面有自己的智能体、文件夹和任务，断开其中一个不会影响其他工作区。",
        ],
      },
    ],
  },
  "workspace-computer": {
    title: "工作区的电脑",
    summary: "每个工作区都有一台始终开机的专属电脑，它的智能体就在上面工作。",
    sections: [
      {
        id: "what",
        heading: "它是什么",
        blocks: [
          "一台只属于这个工作区、始终开机的电脑。每个智能体在上面都有自己的用户，有自己的文件夹、屏幕、浏览器和文件。在智能体页面上，你可以看着它工作，需要时也可以接管操作。",
        ],
      },
      {
        id: "plans",
        heading: "你的 AI 套餐",
        blocks: [
          "你的智能体可以用你自己的 AI 套餐来思考，比如 Claude、ChatGPT、GLM 或 Kimi，只需在这台电脑上登录，无需 API 密钥。账号只留在这台电脑上，agentes.chat 永远看不到密码和登录凭据。",
          "Google 的 AI Pro 和 Ultra 套餐在这里无法使用：Google 的条款不允许在其他产品中使用它们。Gemini 的 API 密钥可以。",
        ],
      },
      {
        id: "size",
        heading: "配置",
        blocks: ["它的 CPU、内存和磁盘显示在 **设置 › 电脑** 中。"],
      },
      {
        id: "trouble",
        heading: "如果它没有响应",
        blocks: ["它通常几分钟内就会恢复，我们也在处理：你这边无需做任何事。"],
      },
    ],
  },
  import: {
    title: "带上你的智能体",
    summary: "从其他应用或另一个 agentes.chat 工作区带来智能体，连同它们的指令、技能、例行工作和记忆。",
    sections: [
      {
        id: "comes",
        heading: "会带过来的内容",
        blocks: [
          {
            list: [
              "智能体，包括名称、角色、指令和形象。",
              "技能，对原来拥有它们的智能体保持开启。",
              "公开频道，以及其中的智能体。",
              "例行工作，保持启用并按原计划运行。如有需要，可以在 **例行工作** 中暂停。",
              "记忆：每个智能体记住的内容。",
              "每个智能体自己的文件（OpenBot.run 的文件夹、OpenClaw 工作区），放在 **Drive** 中以它的名字命名的文件夹里。密钥、登录信息和系统文件不会带过来，已有的内容也不会被替换。",
            ],
          },
        ],
      },
      {
        id: "never",
        heading: "永远不会带过来的内容",
        blocks: [
          "密钥、密码、登录信息和聊天记录永远不会带过来：智能体用工作区的 AI 来思考。有些东西在这里还没有对应项，或者本来就不该放在文件里传递。你可以之后再重新创建。",
          "文件和文件夹在你的浏览器中读取。GitHub 链接会经过工作区的服务器。密钥和登录文件永远不会被打开，在你确认之前什么都不会改变。",
        ],
      },
      {
        id: "other-apps",
        heading: "从其他应用导入",
        blocks: [
          "选择 **Grok Bot**、**ChatGPT dots** 或 **其他应用**。复制请求，粘贴到那个应用中，再把它返回的内容带回来：拖入文件，或粘贴完整回复。各应用的位置：",
          {
            list: [
              "**Grok Bot**：在和你的 bot 的聊天中。它会回复 JSON：复制完整回复。",
              "**ChatGPT dots**：在新聊天中。下载它生成的文件。",
              "**Claude**：在新对话中，或在你的智能体所在的项目中。下载它生成的文件。",
              "**Manus**：在新任务中。文件在任务的结果里。",
              "**Rakazo**：发送给你的智能体。它会回复 JSON：复制完整回复。",
              "**OpenBot**：无需请求。拖入租户文件夹（agents.yaml、agents/、model.yaml、skills.yaml），或粘贴它的 GitHub 链接。",
            ],
          },
        ],
      },
      {
        id: "export",
        heading: "导出工作区",
        blocks: [
          "**设置 › 导入和导出 › 导出** 会下载一个 .json 文件，用来把智能体带到另一个工作区，或留一份备份。文件中包括：",
          {
            list: [
              "智能体，包括指令、模型和形象",
              "技能，包括完整的 SKILL.md",
              "公开频道，以及其中的智能体",
              "定时的例行工作（到了另一边会保持启用）",
              "工作区所有人都能看到的记忆",
            ],
          },
          "永远不包括：",
          {
            list: ["API 密钥和密码", "连接器和登录信息", "电脑", "对话、消息和私有频道", "用量、费用和活动记录"],
          },
          "要使用这个文件，请在另一个工作区打开 **设置 › 导入和导出**，然后拖入 .json 文件。",
        ],
      },
    ],
  },
  wiki: {
    title: "Wiki",
    summary: "公司知道的一切，以相互链接的页面呈现。",
    sections: [
      {
        id: "links",
        heading: "链接",
        blocks: ["输入 [[ 即可链接另一个页面。反向链接和关系图会显示页面之间的联系。"],
      },
      {
        id: "agents",
        heading: "智能体如何使用它",
        blocks: ["智能体回答时会阅读 Wiki。只有在有人要求时，它们才会在里面写内容。"],
      },
      {
        id: "obsidian",
        heading: "导入 Obsidian 仓库",
        blocks: [
          "在设置向导的“背景信息”步骤中，或在 Wiki 自己的导入功能中，拖入仓库文件夹或它的 .zip 文件。[[链接]]、[[note|alias]] 和 [[note#section]] 都能继续使用。标签取自 frontmatter 和正文。附件会放进 Drive，嵌入的图片和文件会变成页面上的卡片。Callout 依然是 callout。Dataview 查询会以文本形式导入：让智能体来生成表格。Canvas 和 Obsidian 的设置（.obsidian）不会导入。",
        ],
      },
    ],
  },
  memory: {
    title: "记忆",
    summary: "每个智能体从对话和团队的纠正中学到的东西。",
    sections: [
      {
        id: "learns",
        heading: "智能体如何学习",
        blocks: [
          "智能体从对话和团队的纠正中学习。智能体知道的内容会在相关时进入它的上下文。在它的 **记忆** 标签页中，可以编辑、置顶或归档错误或过时的内容。",
        ],
      },
      {
        id: "permissions",
        heading: "记忆不授予任何权限",
        blocks: [
          "记忆中的任何内容都不会让智能体能做更多事。它能做什么，始终由 **工具和权限** 决定，敏感操作永远需要审批。",
        ],
      },
      {
        id: "proposals",
        heading: "改进建议",
        blocks: [
          "当同一条经验反复出现时，智能体可能会建议修改自己的指令或工作区的背景信息。在有人接受之前什么都不会改变，接受前还可以先调整文字。之前的版本会保留在历史记录中。被拒绝的建议会作为经验保留下来，不会再次提出。",
        ],
      },
    ],
  },
  approvals: {
    title: "审批",
    summary: "任何敏感操作都离不开人。",
    sections: [
      {
        id: "what",
        heading: "哪些操作要先询问",
        blocks: [
          "当智能体想要合并、部署、回滚、向外部发送内容或删除数据时，无论它有什么权限，都会先询问。请求会出现在 **审批** 和频道中，附有具体操作和原因。",
        ],
      },
      {
        id: "exact",
        heading: "一次审批，一个操作",
        blocks: ["每次审批只涵盖一个具体操作及其参数值。如果智能体改动了任何内容，就必须重新询问。"],
      },
      {
        id: "who",
        heading: "谁来审批",
        blocks: ["智能体的负责人审批它的请求。没有负责人的智能体，由管理员审批。"],
      },
      {
        id: "refusing",
        heading: "拒绝",
        blocks: ["愿意的话可以说明原因：智能体会读到它，调整计划，并把它记作一条经验。"],
      },
      {
        id: "meetings",
        heading: "会议",
        blocks: ["智能体只会建议时间。给成员的邀请总是由提出请求的人发出。"],
      },
    ],
  },
  "who-answers": {
    title: "谁来回复消息",
    summary: "提及会指定智能体。没有提及时，agentes.chat 按以下顺序替你选择。",
    sections: [
      {
        id: "order",
        heading: "消息如何找到它的智能体",
        blocks: [
          "@提及某个智能体的消息会交给那个智能体。没有提及任何人的消息，由工作区拥有的以下第一项来读取：",
          {
            list: [
              "**Jev**，一个专为这类决定打造的小巧快速的模型。",
              "**工作区某个 API 密钥上的小模型**，比如 Claude Haiku 5.5 或 GPT-6 Luna。",
              "**你自己的 Claude 或 ChatGPT 套餐**，只用于你写的消息，在你自己运行的服务器上。它在登录了套餐的那台电脑上读取消息，需要几秒钟。",
              "**简单规则**：回复某个智能体的消息会交给它，紧接着和它对话后的追问也会交给它，在你和一个智能体单独所在的频道里发的消息也一样。",
            ],
          },
          "以上都不适用时，不会有智能体回复。提及一个智能体即可叫它。",
        ],
      },
      {
        id: "jev",
        heading: "Jev",
        blocks: [
          "由 agentes.chat 托管你的工作区时，Jev 已包含在内。在你自己运行的服务器上，它使用所有者的 TypeSafe 密钥，每条消息约 0.0001 美元：[设置 Jev](/help/jev#setup)。",
        ],
      },
      {
        id: "plans",
        heading: "为什么你的套餐只为你的消息做选择",
        blocks: ["Claude 和 ChatGPT 套餐是个人的，所以你的套餐只为你写的消息做选择。"],
      },
      {
        id: "see",
        heading: "查看是谁做的选择",
        blocks: ["打开消息下方的对勾。最后一行会说明是谁选择了智能体。"],
      },
    ],
  },
  jev: {
    title: "Jev",
    summary: "TypeSafe 出品的快速模型，替你的智能体做快速决定。在你自己的服务器上它是可选的，需要你自己的密钥。",
    sections: [
      {
        id: "what",
        heading: "它能做什么",
        blocks: [
          {
            list: [
              "**选择谁来回复。** 没有被 @提及的消息会在一秒内交给合适的智能体，即使你的智能体用套餐思考、你没有 API 密钥也一样。",
              "**整理记忆。** 即使换了说法，它也能认出重复的内容或更新的事实：重复的内容会合并进智能体已知的内容，更新的事实会替换旧的。每天一次，它会整理其余内容。",
              "**看懂屏幕。** 在浏览器和桌面上，智能体可以根据描述找到按钮和输入框，凑近查看小的元素，并在屏幕截图上确认某一步是否成功。",
              "**少读一些。** 每一轮只加载智能体可能用到的工具，让你的 AI 读得更少、花得更少。",
            ],
          },
        ],
      },
      {
        id: "without",
        heading: "没有它时",
        blocks: [
          "一切照常运行，只是更慢，也没那么细致。",
          {
            list: [
              "**谁来回复：** 由你某个 API 密钥上的小模型来选，比如 Claude Haiku 5.5 或 GPT-6 Luna。没有密钥时，由每个人自己的 Claude 或 ChatGPT 套餐为他们写的消息做选择，需要几秒钟。否则，回复和追问仍会交给对应的智能体。提及一个智能体即可叫它。[智能体是如何选出的](/help/who-answers)",
              "**记忆：** 措辞相同的重复内容仍会合并。换了说法的重复和更新会分开保存。",
              "**屏幕：** 智能体使用屏幕上显示的编号和确切的名称。不会从图片中读取任何内容。",
            ],
          },
        ],
      },
      {
        id: "setup",
        heading: "设置",
        blocks: [
          {
            list: [
              "打开 https://console.typesafe.ai ，用 Google 或你的邮箱登录。新账号也用同样的方式创建。",
              "在控制台中充值。Jev 是预付费的。",
              "打开 https://console.typesafe.ai/keys ，创建一个密钥并立即复制。",
              "在 agentes.chat 中打开 **设置 › AI 账号**，把它粘贴到 **Jev** 下面。只有设置这台服务器的人能看到它。",
            ],
          },
          "在用 Docker 运行的服务器上，你也可以把密钥写进 `.env` 的 `TYPESAFE_API_KEY`。它优先于设置中的密钥。",
        ],
      },
      {
        id: "cost",
        heading: "费用",
        blocks: [
          {
            list: [
              "Jev 每读取一百万 token 收费 0.042 美元。它的回答免费。选择谁来回复大约读取 2,500 个 token，也就是约 0.0001 美元。一张屏幕截图大约 3,900 个 token。",
              "购买的额度 12 个月内有效。在控制台中开启自动充值，以免 Jev 额度用完。",
              "**设置 › AI 账号** 会显示 Jev 本月做了多少次决定，以及花了多少钱。",
            ],
          },
        ],
      },
      {
        id: "data",
        heading: "你的数据",
        blocks: [
          "Jev 为了做决定会读取：",
          {
            list: [
              "频道的名称和描述、这条消息以及之前的几条",
              "你的智能体的名称和角色、指令的开头部分，以及它们能使用的工具",
              "它比较的记忆条目",
              "智能体的任务及其工具结果的开头部分",
              "专项任务的目标，以及智能体想为它运行的命令",
              "已连接应用提供的工具",
              "智能体正在使用的页面或屏幕，包括屏幕截图",
            ],
          },
          "TypeSafe 在美国运行 Jev，不会用你发送的内容训练它的模型。它只在提供服务所需的时间内保留数据。它的企业版套餐提供零数据保留。",
          "TypeSafe 的隐私政策：https://typesafe.ai/legal/privacy-policy 。它的数据处理协议：https://typesafe.ai/legal/data-processing 。",
        ],
      },
      {
        id: "problems",
        heading: "当它停止工作时",
        blocks: [
          {
            list: [
              "**密钥不被接受：** 创建一个新密钥，粘贴到 **设置 › AI 账号** 中。",
              "**额度用完：** 在控制台中充值。Jev 会在 30 分钟内重试，你也可以点 **重新检查**。",
              "**繁忙或无法连接：** TypeSafe 可能会限制每秒请求数，或暂时停止响应。Jev 会自行恢复。你的限额：https://console.typesafe.ai/rate-limits 。需要更高的限额，请写信至 sales@typesafe.ai。",
            ],
          },
          "在此期间，智能体会按 [没有它时](/help/jev#without) 的方式工作。",
        ],
      },
    ],
  },
  "apps-de-ia": {
    title: "AI 应用",
    summary: "在 Claude、Cursor 或其他 MCP 应用中直接请 agentes.chat 的智能体完成任务，无需离开，答案就在原处返回。",
    sections: [
      {
        id: "what",
        heading: "工作原理",
        blocks: [
          "agentes.chat 是一个 MCP 服务器。把它的地址粘贴到你的 AI 应用中，用你的账号登录并选择一个工作区。之后，这个应用就可以列出智能体和频道、以你的身份给智能体发送任务、等待回复，以及查看最近的任务。",
          "例如，正在 Unity 或 Blender 里编辑场景时，对 Claude 说：“让市场智能体写一段发布文案”。这条消息会以你的名义出现在 agentes.chat 中，标注 **via Claude**，智能体的回复会回到 Claude。",
          "地址在 **设置 › AI 应用** 中，以 `/mcp` 结尾。",
        ],
      },
      {
        id: "connect",
        heading: "连接应用",
        blocks: [
          {
            list: [
              "**Claude**（claude.ai、Claude Desktop 和手机）：在 **Customize › Connectors** 中点 **+ Add**，再点 **Add custom connector**，命名为 agentes.chat，粘贴地址后点 **Continue**。选择 **Sign in now**，点 **Add** 并授权。在 Team 和 Enterprise 套餐中，由 Claude 组织的 Owner 在 Organization settings › Connectors 中添加连接器，每个人再在 Customize › Connectors 中点 **Connect**。Claude 免费版可以添加一个自定义连接器。",
              "**Claude Code：** 运行 `claude mcp add --transport http --scope user agentes <address>`，然后输入 `/mcp`，选择 agentes 并点 **Authenticate**。只用于当前文件夹时，去掉 `--scope user`。",
              "**Cursor：** 在 **设置 › AI 应用** 中点 **添加到 Cursor**，或把地址写进 `~/.cursor/mcp.json`。第一次使用时，Cursor 会请你登录。",
              '**VS Code：** 点 **添加到 VS Code**，或把地址写进 `.vscode/mcp.json`，并加上 `"type": "http"`。',
              "**其他应用：** ChatGPT, Gemini, Grok, Perplexity, Codex, Zed, JetBrains 等在 **连接应用** 里都有各自的步骤，地址已经填好。",
            ],
          },
          "登录时，agentes.chat 会显示是哪个应用请求访问、之后会返回到哪里。只有在你刚刚发起连接时才继续。",
        ],
      },
      {
        id: "tools",
        heading: "应用能做什么",
        blocks: [
          {
            list: [
              "`send_to_agent`：以你的身份给智能体发送消息，可以在你和它的私信中，也可以在频道中，并等待回复。需要 **查看任务并发送给智能体** 权限。",
              "`wait_for_reply`：继续等待某个任务的回复。",
              "`list_agents`：你能看到的智能体。",
              "`list_channels`：你能阅读的频道。",
              "`read_conversation`：频道、话题或任务中的最近消息。",
              "`list_recent_tasks`：你从应用发出的任务，以及智能体正在做的事。",
            ],
          },
          "应用以你的身份行事，只能看到你能看到的内容。它永远不会审批智能体的操作：当智能体停下来请求审批时，回复中会说明并附上链接，由人在 agentes.chat 中做决定。它也不会更改设置、成员或权限。",
        ],
      },
      {
        id: "workspace",
        heading: "每个连接对应一个工作区",
        blocks: [
          "每个连接只覆盖登录时选择的工作区。要使用另一个工作区，请重新连接应用并选择那个工作区。",
          "在 **设置 › AI 应用** 中，你可以看到已连接的应用、每个应用的最近使用时间，并断开其中任何一个。负责管理成员的人可以看到整个工作区的应用，也可以断开它们。从应用发送的每条消息都会出现在审计日志中。",
        ],
      },
      {
        id: "tokens",
        heading: "个人令牌",
        blocks: [
          "对于不支持 OAuth 登录的脚本和应用，请在 **设置 › AI 应用** 中创建个人令牌，并通过 `Authorization: Bearer` 请求头发送。令牌只显示一次，只在创建它的工作区中有效，有效期可以是 30 天、90 天、1 年或永不过期。",
          "在没有 https 的服务器上，如果不是在服务器本机使用，请用个人令牌：OAuth 登录需要 https。",
        ],
      },
      {
        id: "limits",
        heading: "限额",
        blocks: [
          {
            list: [
              "每个连接每分钟最多 120 个请求，每天最多 5,000 个。",
              "每个人在每个工作区中每分钟最多 20 条消息，每天最多 500 条。",
              "每次等待最长 45 秒。如果智能体还在工作，应用会再次等待。",
            ],
          },
        ],
      },
      {
        id: "safety",
        heading: "他人写的文字",
        blocks: [
          "回复中包含智能体和成员在 agentes.chat 中写的文字。应用收到的这些文字会被标记为内容而非指令，但某段文字仍可能试图诱导应用去做别的事。在确认之前，请检查你的应用将要做什么。",
        ],
      },
      {
        id: "problems",
        heading: "无法连接时",
        blocks: [
          {
            list: [
              "**请求已过期：** 登录页面 30 分钟内有效，且只能使用一次。回到应用重新连接。",
              "**应用要求重新登录：** 连接已被断开、密码已更改，或你已离开工作区。在应用中重新登录。",
              "**Cursor 卡在旧的登录上：** 退出 Cursor，删除 `~/.mcp-auth` 文件夹，然后重新连接。",
            ],
          },
        ],
      },
    ],
  },
  "install-on-a-server": {
    title: "在服务器上安装 agentes.chat",
    summary: "在你自己的服务器上免费运行 agentes.chat，供整个团队使用。一条命令就能装好。",
    sections: [
      {
        id: "need",
        heading: "你需要什么",
        blocks: [
          {
            list: [
              "一台 64 位 Linux（x64 或 arm64）服务器或 VPS。小团队可以从 2 个 CPU、4 GB 内存和 20 GB 磁盘起步。只是试用的话，装了 Docker Desktop、OrbStack 或 Colima 的 Mac 也可以。",
              "带 Compose 的 Docker。在 Linux 上，缺少时安装程序会先问你，再帮你装上。",
              "一种访问方式：一个免费的 Tailscale 账号（默认方式，私有，不需要域名，也不用开放端口），或者一个指向服务器的域名，并开放 80 和 443 端口。",
            ],
          },
        ],
      },
      {
        id: "install",
        heading: "安装",
        blocks: [
          "在服务器上运行：",
          {
            code: "curl -fsSL https://agentes.chat/install | sh",
          },
          "它会装好缺少的东西，然后问几个问题：大家怎么访问、邮件、这台服务器是否也当作智能体的电脑，以及是否发送匿名使用统计。按 Enter 采用建议的答案。它装在 `/opt/agentes`（已经能用 Docker 的用户装在 `~/agentes`），第一次会下载大约 2 GB。",
          "最后它会显示服务器的地址和一个给手机用的二维码。再运行一次也没关系：它会保留你的设置，只补上缺少的部分。",
          "有 Node.js 18 或更新版本时，在空文件夹里运行 `npx @agenteschat/setup` 是同样的设置。没有 Node 的话，它可以从应用的镜像在当前文件夹里运行，最后会给出启动其余部分的命令：",
          {
            code: 'docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work ghcr.io/agentes-chat/agentes:latest setup',
          },
        ],
      },
      {
        id: "reach",
        heading: "大家怎么访问",
        blocks: [
          {
            list: [
              "**Tailscale**，默认方式：在 `https://agentes.<你的tailnet>.ts.net` 上的私有 HTTPS，只有你 Tailscale 网络里的设备能打开。安装前，先在 https://console.tailscale.com/admin/dns 打开 MagicDNS 和 HTTPS，并在 https://console.tailscale.com/admin/settings/keys 创建一个认证密钥（auth key），设置时会要用。",
              "**公开域名**：互联网上任何人都能打开，比如 `https://chat.example.com`。把域名指向服务器，开放 80 和 443 端口。设置会申请并续期证书，并在域名上线前让你先创建账号。",
              "**只在这台机器**：`http://localhost:3000`，用来在你自己的电脑上试用。",
            ],
          },
          "在 Tailscale 上，服务器的密钥 180 天后过期，过期后服务器会离开你的网络。要让它一直在，打开 https://console.tailscale.com/admin/machines ，在服务器的 **⋯** 菜单里选择 **Disable Key Expiry**。",
          "启动例行任务的 Webhook，以及从自己服务器发起调用的 AI 应用，需要一个公开地址。在 Tailscale 上，Funnel 可以把同一个地址开放到互联网：在 https://console.tailscale.com/admin/acls 把 Funnel 加进你 tailnet 的策略，在 `.env` 里设置 `TAILSCALE_FUNNEL=true`，然后运行 `docker compose up -d`。",
        ],
      },
      {
        id: "owner",
        heading: "你的账号",
        blocks: [
          "打开服务器的地址并注册：第一个账号就是所有者。之后注册会关闭，其他人通过邀请加入，邀请在 **设置\u00a0›\u00a0成员和邀请** 里发出。",
          "在 Tailscale 上，你邀请的人也需要加入你的 tailnet。先在 https://console.tailscale.com/admin/users 邀请他们，再在 agentes.chat 里邀请。",
        ],
      },
      {
        id: "email",
        heading: "邮件",
        blocks: [
          "没有配置邮件时，agentes.chat 会把每封邮件写进日志而不是发出去，所以邀请链接可以从日志里复制。重置密码不可用。",
          {
            code: "docker compose logs agentes | grep 'email (not sent'",
          },
          "设置可以使用你自己的邮件服务器（SMTP），或者一个兼容 Resend 的 API 密钥，比如 MillionSend 或 Resend。除非你另选发件人，邮件会从服务器域名的 `ping@` 发出，这个域名需要在你的邮件服务商那里验证过。以后想配置，再运行一次安装就行。",
        ],
      },
      {
        id: "phone",
        heading: "你的手机",
        blocks: [
          {
            list: [
              "使用 Tailscale 时，在手机上安装 Tailscale 应用，并登录同一个 tailnet。",
              "安装 agentes.chat 应用。",
              "扫描设置显示的二维码，或者 **设置\u00a0›\u00a0你的账号\u00a0›\u00a0在手机上打开** 里的二维码，后者还会帮你登录。",
            ],
          },
        ],
      },
      {
        id: "computers",
        heading: "智能体的电脑",
        blocks: [
          "设置可以把这台服务器也当作智能体的电脑，它们在上面运行命令、使用浏览器、存放文件。设置会先问你，在服务器能胜任时建议选是。在 Linux 上，每个智能体都有自己的用户和屏幕。如果你选了否，加上 `--computer yes` 再运行一次安装：",
          {
            code: "curl -fsSL https://agentes.chat/install | sh -s -- --computer yes",
          },
          "其他电脑，比如装了 agentes.chat 应用的 Mac 或另一台服务器，在 **设置\u00a0›\u00a0电脑** 里连接，详见 [给智能体用的电脑](/help/computers)。使用 Tailscale 时，它们要先加入你的 tailnet。",
        ],
      },
      {
        id: "backups",
        heading: "备份和恢复",
        blocks: [
          "你的服务器由三样东西组成：数据库、上传的文件，以及 `.env` 里的 `AGENTES_SECRET`。把 `.env` 的副本放在安全的地方，和备份分开：没有这个密钥，恢复后的数据库里存的密钥就读不出来。",
          "要每天备份，在 Cloudflare R2 或其他兼容 S3 的存储上建一个私有存储桶，再建一个能在里面读、写、删除的密钥。把它们加到 `.env`，并在 `COMPOSE_PROFILES` 里加上 `backup`（用公开域名时是 `https,backup`）：",
          {
            code: "S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com\nS3_ACCESS_KEY_ID=…\nS3_SECRET_ACCESS_KEY=…\nS3_BACKUP_BUCKET=agentes-backups\nCOMPOSE_PROFILES=tailscale,backup",
          },
          "然后在安装文件夹里运行 `docker compose up -d`。数据库会在 03:00 UTC 导出，每份导出保留 14 天。`docker compose run --rm backup now` 立即做一份，`docker compose run --rm backup list` 列出所有导出。导出只包含数据库：`files` 卷里上传的文件需要单独复制，命令在下面的完整指南里。",
          "要恢复，先用 `docker compose run --rm -T backup fetch <名称> > agentes.dump` 取回一份导出，然后在应用停止时把它载入一个空数据库：",
          {
            code: "docker compose stop agentes\ndocker compose exec -T postgres dropdb -U agentes --force agentes\ndocker compose exec -T postgres createdb -U agentes agentes\ndocker compose exec -T postgres pg_restore -U agentes -d agentes --exit-on-error < agentes.dump\ndocker compose start agentes",
          },
          "恢复到做这份导出的版本，或者更新的版本。",
        ],
      },
      {
        id: "upgrades",
        heading: "升级",
        blocks: [
          "在安装文件夹里运行：",
          {
            code: "curl -fsSLO https://agentes.chat/install/docker-compose.yml\ndocker compose pull\ndocker compose up -d",
          },
          "新版本启动时，数据库会自动更新。把设置放在 `.env` 里，不要修改 `docker-compose.yml`，每次升级都会替换它。大版本跨越前先备份：被新版本更新过的数据库，旧版本打不开。",
        ],
      },
      {
        id: "data",
        heading: "它会发送什么",
        blocks: [
          "服务器每天向 agentes.chat 发送一次匿名使用统计：人数、智能体数量、机器大小、用掉的 AI 令牌，以及智能体的浏览器收发了多少数据等计数。从不发送消息、文件、名字或网站。`docker compose run --rm agentes telemetry` 会原样显示将要发送的内容。所有者可以在 **设置\u00a0›\u00a0常规** 里关闭，或者在 `.env` 里设置 `TELEMETRY=off`。",
          "除非你把 `SENTRY_DSN` 设为你自己选的兼容 Sentry 的服务器，否则错误报告不会发到任何地方。报告包含错误和发生的位置，从不包含消息、邮箱地址、IP 地址、Cookie 或令牌。",
        ],
      },
      {
        id: "reference",
        heading: "完整指南",
        blocks: [
          "所有设置、自己的代理（比如 nginx）、不用 Docker 的运行方式、给自行安装的 AI 智能体的步骤，以及出问题时怎么办，都在 agentes.chat 仓库里的 `SELF_HOSTING.md` 中。",
        ],
      },
    ],
  },
};
