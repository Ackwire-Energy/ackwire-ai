import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

/** The help pages in ko: a page not here shows in English. */
export const helpKo: Partial<Record<HelpSlug, HelpDocument>> = {
  "run-on-your-computer": {
    title: "내 컴퓨터에서 agentes.chat 실행하기",
    summary:
      "agentes.chat 앱은 Mac, PC, Linux 컴퓨터에서 agentes.chat 자체를 실행할 수도 있어요. 혼자 쓰거나 작은 팀에 알맞아요.",
    sections: [
      {
        id: "how",
        heading: "실행 방식",
        blocks: [
          "앱 안에서 실행되고 데이터베이스도 내장되어 있어요. 모든 데이터는 이 컴퓨터의 홈 폴더에 있는 `.agentes` 폴더 하나에 저장돼요. 따로 설치할 건 없어요. Docker도, 데이터베이스 설정도 필요 없어요.",
          "앱을 열면 시작되고 종료하면 멈춰요. 앱을 다시 열 때까지 아무도 agentes.chat을 쓸 수 없어서, 종료하기 전에 먼저 물어봐요.",
        ],
      },
      {
        id: "who",
        heading: "누구에게 맞나요",
        blocks: [
          "이 컴퓨터가 켜져 있는 동안 혼자 또는 작은 팀이 쓰기 좋아요. 더 큰 팀이거나 항상 켜져 있는 서버가 필요하다면 [서버에 agentes.chat을 설치](/help/install-on-a-server)하고 앱에서 **내 서버에 연결**을 고르세요. 데이터는 나중에 옮길 수 있어요.",
        ],
      },
      {
        id: "agents",
        heading: "에이전트도 여기서 일해요",
        blocks: [
          "에이전트도 이 컴퓨터에서 각자의 폴더와 브라우저를 쓰며 일하고, Claude Code나 Codex가 설치되어 있으면 그것도 써요. 명령 실행은 **환경설정 › 도구**에서 켜기 전까지 꺼져 있어요.",
        ],
      },
      {
        id: "reach",
        heading: "휴대폰과 팀원에게서 접속",
        blocks: [
          "**휴대폰과 팀원이 접속할 수 있게 하기**를 켜면 agentes.chat이 내 기기 전용 사설 네트워크인 Tailscale에 연결돼요. 내 휴대폰과 초대한 사람만 참여할 수 있고, 다른 사람은 agentes.chat에 접속할 수 없어요. Tailscale은 무료예요: https://tailscale.com/download. 끄면 agentes.chat은 이 컴퓨터에서만 작동해요.",
        ],
      },
      {
        id: "backups",
        heading: "백업과 이전",
        blocks: [
          "**환경설정 › 서버**의 **지금 백업**은 데이터베이스, 파일, 설정을 홈 폴더의 `.agentes/backups`에 저장해요.",
        ],
      },
    ],
  },
  computers: {
    title: "에이전트를 위한 컴퓨터",
    summary:
      "에이전트는 연결한 컴퓨터에서 코드를 실행하고 파일을 다뤄요. agentes.chat 앱이 설치된 Mac이나 PC, 또는 서버를 연결할 수 있어요.",
    sections: [
      {
        id: "mac",
        heading: "앱이 설치된 Mac이나 PC",
        blocks: [
          "agentes.chat 앱은 내 서버를 별도 창으로 열고, 클릭 한 번으로 그 서버의 에이전트가 이 컴퓨터의 각자 폴더에서 일하게 해 줘요. 앱을 설치해서 열고 **내 서버 사용 › 내 서버에 연결**을 고른 다음 서버 주소를 입력하세요. 로그인한 뒤 **설정 › 컴퓨터**에서 **이 Mac 사용**(Windows에서는 **이 PC 사용**, Linux에서는 **이 컴퓨터 사용**)을 클릭하세요.",
        ],
      },
      {
        id: "server",
        heading: "서버나 Linux 컴퓨터",
        blocks: [
          "**설정 › 컴퓨터**에서 **다른 방법** 아래의 명령을 복사해 그 컴퓨터의 터미널에서 실행하세요. 코드와 링크가 나와요. 링크를 열어 코드가 같은지 확인하고 내 계정으로 확인하세요. 미리 설치할 건 없어요.",
        ],
      },
      {
        id: "folders",
        heading: "폴더",
        blocks: [
          "에이전트마다 항상 `~/agentes/<workspace>`에 자기 폴더가 있어요. 다른 폴더는 웹사이트가 아니라 컴퓨터에서 직접만 허용할 수 있어요. 앱에서는 **환경설정 › 폴더**, 서버에서는 `agentes-runner folders allow`로 허용하세요. 폴더 허용은 워크스페이스마다 따로예요. 한 워크스페이스에서 허용한 폴더는 그 워크스페이스의 에이전트에게만 적용돼요. 폴더를 제거해도 아무것도 삭제되지 않고 접근 권한만 없어져요.",
        ],
      },
      {
        id: "pausing",
        heading: "일시 중지",
        blocks: [
          "앱에서는 컴퓨터를 연결한 사람이 시계 옆의 agentes.chat 아이콘으로 그 컴퓨터의 에이전트를 일시 중지할 수 있어요. 재개할 때까지 새 작업은 시작되지 않고, 실행 중이던 작업은 끝까지 마쳐요.",
        ],
      },
      {
        id: "organizations",
        heading: "여러 워크스페이스",
        blocks: [
          "컴퓨터 한 대가 여러 워크스페이스를 위해 일할 수 있어요. 워크스페이스마다 그 컴퓨터에 자기 에이전트, 폴더, 작업이 있고, 하나를 연결 해제해도 나머지는 그대로예요.",
        ],
      },
    ],
  },
  "workspace-computer": {
    title: "워크스페이스 컴퓨터",
    summary: "워크스페이스마다 항상 켜져 있는 전용 컴퓨터가 있고, 에이전트는 거기서 일해요.",
    sections: [
      {
        id: "what",
        heading: "어떤 컴퓨터인가요",
        blocks: [
          "이 워크스페이스만을 위한, 항상 켜져 있는 컴퓨터예요. 에이전트마다 전용 사용자가 있고, 각자의 폴더, 화면, 브라우저, 파일이 있어요. 에이전트 페이지에서 일하는 모습을 지켜보고, 필요하면 직접 조작할 수 있어요.",
        ],
      },
      {
        id: "plans",
        heading: "내 AI 요금제",
        blocks: [
          "에이전트는 이 컴퓨터에 로그인한 내 AI 요금제(Claude, ChatGPT, GLM, Kimi 등)로 생각할 수 있어요. API 키는 필요 없어요. 계정은 이 컴퓨터에만 남고, agentes.chat은 비밀번호나 접근 권한을 절대 보지 않아요.",
          "Google의 AI Pro와 Ultra 요금제는 여기서 쓸 수 없어요. Google 약관상 다른 제품에서 쓸 수 없기 때문이에요. Gemini API 키는 쓸 수 있어요.",
        ],
      },
      {
        id: "size",
        heading: "사양",
        blocks: ["CPU, 메모리, 디스크는 **설정 › 컴퓨터**에서 볼 수 있어요."],
      },
      {
        id: "trouble",
        heading: "응답이 없을 때",
        blocks: ["보통 몇 분 안에 돌아오고, 저희가 이미 살펴보고 있어요. 따로 하실 일은 없어요."],
      },
    ],
  },
  import: {
    title: "에이전트 가져오기",
    summary: "다른 앱이나 다른 agentes.chat 워크스페이스에서 에이전트를 지침, 스킬, 루틴, 메모리와 함께 가져오세요.",
    sections: [
      {
        id: "comes",
        heading: "함께 오는 것",
        blocks: [
          {
            list: [
              "에이전트: 이름, 역할, 지침, 모습까지.",
              "스킬: 원래 쓰던 에이전트에게 켜진 상태로.",
              "공개 채널: 채널에 있던 에이전트와 함께.",
              "루틴: 활성 상태로, 원래 일정대로. 원하면 **루틴**에서 일시 중지하세요.",
              "메모리: 각 에이전트가 기억하는 내용.",
              "에이전트별 파일(OpenBot.run의 files 폴더, OpenClaw 워크스페이스)은 **Drive**에 에이전트 이름의 폴더로 들어가요. 키, 로그인 정보, 시스템 파일은 가져오지 않고, 이미 있는 파일은 바꾸지 않아요.",
            ],
          },
        ],
      },
      {
        id: "never",
        heading: "절대 오지 않는 것",
        blocks: [
          "키, 비밀번호, 로그인 정보, 채팅 기록은 절대 가져오지 않아요. 에이전트는 워크스페이스의 AI로 생각해요. 아직 여기에 대응하는 기능이 없거나 파일로 옮기면 안 되는 것도 있어요. 나중에 다시 만들 수 있어요.",
          "파일과 폴더는 브라우저에서 읽어요. GitHub 링크는 워크스페이스 서버를 거쳐요. 키와 로그인 파일은 절대 열지 않고, 확인하기 전에는 아무것도 바뀌지 않아요.",
        ],
      },
      {
        id: "other-apps",
        heading: "다른 앱에서",
        blocks: [
          "**Grok Bot**, **ChatGPT dots**, **다른 앱** 중에서 고르세요. 요청문을 복사해 그 앱에 붙여넣고, 돌려받은 내용을 가져오세요. 파일을 끌어다 놓거나 답변 전체를 붙여넣으면 돼요. 앱별로 넣는 곳:",
          {
            list: [
              "**Grok Bot**: 내 봇과의 채팅에. JSON으로 답하니 답변 전체를 복사하세요.",
              "**ChatGPT dots**: 새 채팅에. 만들어 준 파일을 내려받으세요.",
              "**Claude**: 새 대화나 에이전트 프로젝트에. 만들어 준 파일을 내려받으세요.",
              "**Manus**: 새 작업에. 파일은 작업 결과에 있어요.",
              "**Rakazo**: 내 에이전트에게 보내세요. JSON으로 답하니 답변 전체를 복사하세요.",
              "**OpenBot**: 요청문이 필요 없어요. 테넌트 폴더(agents.yaml, agents/, model.yaml, skills.yaml)를 끌어다 놓거나 GitHub 링크를 붙여넣으세요.",
            ],
          },
        ],
      },
      {
        id: "export",
        heading: "워크스페이스 내보내기",
        blocks: [
          "**설정 › 가져오기와 내보내기 › 내보내기**를 누르면 .json 파일을 내려받아요. 에이전트를 다른 워크스페이스로 옮기거나 사본을 보관할 때 쓰세요. 파일에 담기는 것:",
          {
            list: [
              "에이전트: 지침, 모델, 모습까지",
              "스킬: SKILL.md 전체까지",
              "공개 채널: 채널의 에이전트까지",
              "예약된 루틴(가져간 곳에서 활성 상태로 시작해요)",
              "워크스페이스의 모두가 볼 수 있는 메모리",
            ],
          },
          "절대 담기지 않는 것:",
          {
            list: [
              "API 키와 비밀번호",
              "커넥터와 로그인 정보",
              "컴퓨터",
              "대화, 메시지, 비공개 채널",
              "사용량, 비용, 활동 기록",
            ],
          },
          "파일을 쓰려면 다른 워크스페이스에서 **설정 › 가져오기와 내보내기**를 열고 .json 파일을 끌어다 놓으세요.",
        ],
      },
    ],
  },
  wiki: {
    title: "Wiki",
    summary: "회사가 아는 것을 서로 연결된 페이지로 모아 둬요.",
    sections: [
      {
        id: "links",
        heading: "링크",
        blocks: [
          "[[를 입력하면 다른 페이지로 링크할 수 있어요. 백링크와 그래프에서 페이지가 어떻게 연결되는지 보여요.",
        ],
      },
      {
        id: "agents",
        heading: "에이전트가 쓰는 방법",
        blocks: ["에이전트는 답할 때 Wiki를 읽어요. Wiki에 글을 쓰는 건 누군가 요청할 때뿐이에요."],
      },
      {
        id: "obsidian",
        heading: "Obsidian 보관함 가져오기",
        blocks: [
          "보관함 폴더나 그 .zip 파일을 설정의 컨텍스트 단계나 Wiki 자체의 가져오기에 끌어다 놓으세요. [[링크]], [[note|alias]], [[note#section]]은 그대로 작동해요. 태그는 frontmatter와 본문에서 가져와요. 첨부 파일은 Drive로 가고, 삽입된 이미지와 파일은 페이지의 카드가 돼요. 콜아웃은 콜아웃으로 남아요. Dataview 쿼리는 텍스트로 들어오니 표는 에이전트에게 만들어 달라고 하세요. 캔버스와 Obsidian 설정(.obsidian)은 가져오지 않아요.",
        ],
      },
    ],
  },
  memory: {
    title: "메모리",
    summary: "각 에이전트가 대화와 팀의 수정에서 배우는 것.",
    sections: [
      {
        id: "learns",
        heading: "에이전트가 배우는 방법",
        blocks: [
          "에이전트는 대화와 팀의 수정에서 배워요. 에이전트가 아는 내용은 관련 있을 때 컨텍스트에 들어가요. **메모리** 탭에서 틀리거나 오래된 내용을 수정하거나 고정하거나 보관하세요.",
        ],
      },
      {
        id: "permissions",
        heading: "메모리는 권한을 주지 않아요",
        blocks: [
          "메모리에 무엇이 있든 에이전트가 더 많은 일을 할 수 있게 되지는 않아요. 할 수 있는 일은 **도구 및 접근 권한**에서 정해지고, 민감한 작업은 항상 승인을 요청해요.",
        ],
      },
      {
        id: "proposals",
        heading: "변경 제안",
        blocks: [
          "같은 교훈이 반복되면 에이전트가 자기 지침이나 워크스페이스 컨텍스트를 바꾸자고 제안할 수 있어요. 누군가 수락하기 전에는 아무것도 바뀌지 않고, 수락 전에 문구를 고칠 수도 있어요. 이전 버전은 기록에 남아요. 거절된 제안은 교훈으로 남아서 다시 제안되지 않아요.",
        ],
      },
    ],
  },
  approvals: {
    title: "승인",
    summary: "민감한 일은 사람 없이 일어나지 않아요.",
    sections: [
      {
        id: "what",
        heading: "먼저 물어보는 일",
        blocks: [
          "에이전트가 병합, 배포, 롤백, 외부로 무언가 보내기, 데이터 삭제를 하려고 하면 어떤 접근 권한이 있든 먼저 물어봐요. 요청은 **승인**과 채널에 정확한 작업 내용과 이유와 함께 표시돼요.",
        ],
      },
      {
        id: "exact",
        heading: "승인 하나에 작업 하나",
        blocks: [
          "승인 하나는 값까지 정해진 정확한 작업 하나에만 적용돼요. 에이전트가 무엇이든 바꾸면 다시 물어봐야 해요.",
        ],
      },
      {
        id: "who",
        heading: "누가 승인하나요",
        blocks: ["에이전트의 소유자가 그 에이전트의 요청을 승인해요. 소유자가 없는 에이전트는 관리자가 승인해요."],
      },
      {
        id: "refusing",
        heading: "거절하기",
        blocks: ["원하면 이유를 적어 주세요. 에이전트가 읽고 계획을 고친 뒤 교훈으로 기억해요."],
      },
      {
        id: "meetings",
        heading: "회의",
        blocks: ["에이전트는 시간을 제안만 해요. 사람에게 보내는 초대는 항상 요청한 사람을 거쳐요."],
      },
    ],
  },
  "who-answers": {
    title: "누가 메시지에 답하나요",
    summary: "멘션하면 그 에이전트가 답해요. 멘션이 없으면 agentes.chat이 아래 순서대로 골라 줘요.",
    sections: [
      {
        id: "order",
        heading: "메시지가 에이전트를 찾는 방법",
        blocks: [
          "에이전트를 @멘션한 메시지는 그 에이전트에게 가요. 아무도 멘션하지 않은 메시지는 워크스페이스에 있는 다음 중 첫 번째가 읽어요.",
          {
            list: [
              "**Jev**: 이런 결정을 위해 만든 작고 빠른 모델.",
              "**워크스페이스 API 키 중 하나로 쓰는 작은 모델**: Claude Haiku 5.5나 GPT-6 Luna 같은 모델.",
              "**내 Claude 또는 ChatGPT 요금제**: 직접 운영하는 서버에서 내가 쓴 메시지에만. 요금제가 로그인된 컴퓨터에서 읽고, 몇 초 걸려요.",
              "**간단한 규칙**: 에이전트에게 단 답글은 그 에이전트에게 가요. 방금 대화한 에이전트에게 바로 이어서 보낸 메시지, 나와 에이전트 하나만 있는 채널의 메시지도 마찬가지예요.",
            ],
          },
          "어느 것도 맞지 않으면 아무 에이전트도 답하지 않아요. 에이전트를 부르려면 멘션하세요.",
        ],
      },
      {
        id: "jev",
        heading: "Jev",
        blocks: [
          "agentes.chat이 워크스페이스를 호스팅하면 Jev가 포함돼요. 직접 운영하는 서버에서는 소유자의 TypeSafe 키를 쓰고, 메시지당 약 US$ 0.0001이 들어요: [Jev 설정하기](/help/jev#setup).",
        ],
      },
      {
        id: "plans",
        heading: "내 요금제가 내 메시지만 고르는 이유",
        blocks: ["Claude와 ChatGPT 요금제는 개인용이라서, 내 요금제는 내가 쓴 메시지에 대해서만 골라요."],
      },
      {
        id: "see",
        heading: "누가 골랐는지 보기",
        blocks: ["메시지 아래의 체크 표시를 열어 보세요. 마지막 줄에 누가 에이전트를 골랐는지 나와요."],
      },
    ],
  },
  jev: {
    title: "Jev",
    summary:
      "TypeSafe가 만든 빠른 모델로, 에이전트를 위해 빠른 결정을 내려요. 내 서버에서는 선택 사항이고, 내 키로 써요.",
    sections: [
      {
        id: "what",
        heading: "하는 일",
        blocks: [
          {
            list: [
              "**답할 에이전트를 골라요.** 아무도 @멘션하지 않은 메시지를 1초 안에 알맞은 에이전트에게 보내요. 에이전트가 요금제로 생각하고 API 키가 없어도 돼요.",
              "**메모리를 정리해요.** 다른 말로 쓰여 있어도 중복이나 더 새로운 사실을 알아봐요. 중복은 에이전트가 알던 내용과 합치고, 새로운 사실은 옛 사실을 대신해요. 하루에 한 번 나머지도 정리해요.",
              "**화면을 봐요.** 에이전트가 브라우저와 데스크톱에서 설명만으로 버튼과 입력란을 찾고, 작은 건 더 가까이 보고, 화면 이미지로 단계가 잘 됐는지 확인해요.",
              "**덜 읽게 해요.** 턴마다 에이전트에게 필요할 것 같은 도구만 불러와서, AI가 덜 읽고 비용도 줄어요.",
            ],
          },
        ],
      },
      {
        id: "without",
        heading: "Jev가 없으면",
        blocks: [
          "모든 게 계속 작동하지만, 더 느리고 덜 꼼꼼해요.",
          {
            list: [
              "**답할 에이전트:** API 키 중 하나로 Claude Haiku 5.5나 GPT-6 Luna 같은 작은 모델이 골라요. 키가 없으면 각자의 Claude 또는 ChatGPT 요금제가 그 사람이 쓴 메시지에 대해 몇 초 안에 골라요. 그것도 없으면 답글이나 이어서 보낸 메시지는 여전히 해당 에이전트에게 가요. 에이전트를 부르려면 멘션하세요. [에이전트를 고르는 방법](/help/who-answers)",
              "**메모리:** 같은 말로 된 중복은 여전히 합쳐져요. 다른 말로 된 중복과 업데이트는 따로 남아요.",
              "**화면:** 에이전트는 화면에 표시된 번호와 정확한 이름을 써요. 이미지에서는 아무것도 읽지 않아요.",
            ],
          },
        ],
      },
      {
        id: "setup",
        heading: "설정하기",
        blocks: [
          {
            list: [
              "TypeSafe 콘솔(https://console.typesafe.ai)을 열고 Google이나 이메일로 로그인하세요. 새 계정도 같은 방법으로 만들어져요.",
              "콘솔에서 크레딧을 충전하세요. Jev는 선불이에요.",
              "키 페이지(https://console.typesafe.ai/keys)를 열어 키를 만들고 바로 복사하세요.",
              "agentes.chat에서 **설정 › AI 계정**을 열고 **Jev** 아래에 붙여넣으세요. 이 서버를 설정한 사람만 볼 수 있어요.",
            ],
          },
          "Docker로 운영하는 서버라면 대신 `.env`에 `TYPESAFE_API_KEY`로 키를 넣어도 돼요. 그 키가 설정의 키보다 우선해요.",
        ],
      },
      {
        id: "cost",
        heading: "비용",
        blocks: [
          {
            list: [
              "Jev가 읽는 토큰 100만 개당 US$ 0.042예요. 답변은 무료예요. 답할 에이전트를 고를 때 약 2,500토큰을 읽으니 약 US$ 0.0001이에요. 스크린샷 한 장은 약 3,900토큰이에요.",
              "구매한 크레딧은 12개월 동안 유효해요. Jev 크레딧이 떨어지지 않도록 콘솔에서 자동 충전을 켜 두세요.",
              "**설정 › AI 계정**에서 이번 달 Jev가 내린 결정 수와 비용을 볼 수 있어요.",
            ],
          },
        ],
      },
      {
        id: "data",
        heading: "내 데이터",
        blocks: [
          "Jev가 결정하려고 읽는 것:",
          {
            list: [
              "채널 이름과 설명, 메시지와 그 직전 몇 개",
              "에이전트의 이름과 역할, 지침의 앞부분, 쓸 수 있는 도구",
              "비교하는 메모리 항목",
              "에이전트의 작업과 도구 결과의 앞부분",
              "미션의 목표와 에이전트가 그 미션을 위해 실행하려는 명령",
              "연결된 앱이 제공하는 도구",
              "에이전트가 쓰고 있는 페이지나 화면(스크린샷 포함)",
            ],
          },
          "TypeSafe는 Jev를 미국에서 운영하고, 보낸 내용으로 모델을 학습시키지 않아요. 데이터는 서비스 운영에 필요한 기간만 보관해요. 엔터프라이즈 요금제에서는 데이터를 전혀 보관하지 않는 옵션도 있어요.",
          "TypeSafe 개인정보처리방침: https://typesafe.ai/legal/privacy-policy. 데이터 처리 계약: https://typesafe.ai/legal/data-processing.",
        ],
      },
      {
        id: "problems",
        heading: "멈췄을 때",
        blocks: [
          {
            list: [
              "**키가 거부됨:** 새 키를 만들어 **설정 › AI 계정**에 붙여넣으세요.",
              "**크레딧 부족:** 콘솔에서 크레딧을 충전하세요. Jev는 30분 안에 다시 시도하고, **다시 확인**을 클릭해도 돼요.",
              "**사용량이 많거나 연결 불가:** TypeSafe가 초당 요청 수를 제한하거나 잠시 응답하지 않을 수 있어요. Jev는 스스로 다시 작동해요. 내 한도: https://console.typesafe.ai/rate-limits. 더 높은 한도가 필요하면 sales@typesafe.ai로 문의하세요.",
            ],
          },
          "그동안 에이전트는 [Jev가 없으면](/help/jev#without)처럼 일해요.",
        ],
      },
    ],
  },
  "apps-de-ia": {
    title: "AI 앱",
    summary:
      "Claude, Cursor 등 MCP 앱을 떠나지 않고 agentes.chat의 에이전트에게 작업을 맡기고, 그 자리에서 답을 받으세요.",
    sections: [
      {
        id: "what",
        heading: "작동 방식",
        blocks: [
          "agentes.chat은 MCP 서버예요. AI 앱에 주소를 붙여넣고, 내 계정으로 로그인하고, 워크스페이스를 고르세요. 그러면 앱이 에이전트와 채널 목록을 보고, 나 대신 에이전트에게 작업을 보내고, 답을 기다리고, 최근 작업을 읽을 수 있어요.",
          '예를 들어 Unity나 Blender에서 장면 작업을 하다가 Claude에게 "마케팅 에이전트에게 출시 소개 문구를 부탁해 줘"라고 하세요. 메시지는 agentes.chat에 내 메시지로 **Claude 경유** 표시와 함께 나타나고, 에이전트의 답은 Claude로 돌아와요.',
          "주소는 **설정 › AI 앱**에 있어요. `/mcp`로 끝나요.",
        ],
      },
      {
        id: "connect",
        heading: "앱 연결하기",
        blocks: [
          {
            list: [
              "**Claude**(claude.ai, Claude Desktop, 휴대폰): **맞춤 설정 › 커넥터**(Customize › Connectors)에서 **+ 추가**를 클릭하고 **사용자 지정 커넥터 추가**(Add custom connector)를 클릭하세요. 이름을 agentes.chat으로 정하고 주소를 붙여넣은 뒤 **계속**을 클릭하세요. **지금 로그인**(Sign in now)을 고르고 **추가**를 클릭한 다음 권한을 허용하세요. Team과 Enterprise 요금제에서는 Claude 조직의 소유자가 조직 설정 › 커넥터에서 커넥터를 추가하고, 각자 맞춤 설정 › 커넥터에서 **연결**을 클릭해요. Claude 무료 요금제에서는 사용자 지정 커넥터를 하나 추가할 수 있어요.",
              "**Claude Code:** `claude mcp add --transport http --scope user agentes <주소>`를 실행한 다음 `/mcp`를 입력하고 agentes를 골라 **Authenticate**를 선택하세요. 현재 폴더에서만 쓰려면 `--scope user`를 빼세요.",
              "**Cursor:** **설정 › AI 앱**에서 **Cursor에 추가**를 누르거나, `~/.cursor/mcp.json`에 주소를 넣으세요. 처음 쓸 때 Cursor가 로그인을 요청해요.",
              '**VS Code:** **VS Code에 추가**를 누르거나, `.vscode/mcp.json`에 `"type": "http"`와 함께 주소를 넣으세요.',
              "**다른 앱:** ChatGPT, Gemini, Grok, Perplexity, Codex, Zed, JetBrains 등은 **앱 연결**에 각자의 단계가 있고, 주소도 미리 채워져 있어요.",
            ],
          },
          "로그인할 때 agentes.chat이 어떤 앱이 접근을 요청했고 어디로 돌아가는지 보여 줘요. 방금 직접 연결을 시작한 경우에만 계속하세요.",
        ],
      },
      {
        id: "tools",
        heading: "앱이 할 수 있는 일",
        blocks: [
          {
            list: [
              "`send_to_agent`: 에이전트와의 비공개 대화나 채널에서 나 대신 에이전트에게 메시지를 보내고 답을 기다려요. **에이전트 작업 읽기 및 보내기** 권한이 있을 때만 쓸 수 있어요.",
              "`wait_for_reply`: 작업의 답을 계속 기다려요.",
              "`list_agents`: 내가 볼 수 있는 에이전트.",
              "`list_channels`: 내가 읽을 수 있는 채널.",
              "`read_conversation`: 채널, 스레드, 작업의 최근 메시지.",
              "`list_recent_tasks`: 앱에서 보낸 작업과 에이전트가 지금 하고 있는 일.",
            ],
          },
          "앱은 나로서 행동하고 내가 볼 수 있는 것만 봐요. 에이전트의 작업을 승인하지는 않아요. 에이전트가 승인을 요청하며 멈추면 답에 링크와 함께 그 사실이 나오고, 결정은 agentes.chat에서 사람이 해요. 설정, 멤버, 권한도 바꾸지 않아요.",
        ],
      },
      {
        id: "workspace",
        heading: "연결 하나에 워크스페이스 하나",
        blocks: [
          "연결마다 로그인할 때 고른 워크스페이스 하나에만 적용돼요. 다른 워크스페이스를 쓰려면 앱을 다시 연결하고 그 워크스페이스를 고르세요.",
          "**설정 › AI 앱**에서 연결된 앱과 각 앱을 마지막으로 쓴 시점을 보고, 어느 앱이든 연결을 끊을 수 있어요. 멤버를 관리하는 사람은 워크스페이스 전체의 앱을 보고 연결을 끊을 수도 있어요. 앱에서 보낸 메시지는 모두 감사 로그에 남아요.",
        ],
      },
      {
        id: "tokens",
        heading: "개인 토큰",
        blocks: [
          "OAuth 로그인을 지원하지 않는 스크립트와 앱에서는 **설정 › AI 앱**에서 개인 토큰을 만들어 `Authorization: Bearer` 헤더로 보내세요. 토큰은 한 번만 표시되고, 만든 워크스페이스에서만 작동하며, 30일, 90일, 1년 후에 만료되거나 만료되지 않게 할 수 있어요.",
          "https가 없는 서버를 다른 컴퓨터에서 쓸 때는 개인 토큰을 쓰세요. OAuth 로그인에는 https가 필요해요.",
        ],
      },
      {
        id: "limits",
        heading: "한도",
        blocks: [
          {
            list: [
              "연결당 1분에 최대 120건, 하루 최대 5,000건의 요청.",
              "워크스페이스마다 한 사람당 1분에 최대 20개, 하루 최대 500개의 메시지.",
              "한 번 기다리는 시간은 최대 45초예요. 에이전트가 아직 일하고 있으면 앱이 다시 기다려요.",
            ],
          },
        ],
      },
      {
        id: "safety",
        heading: "다른 사람이 쓴 글",
        blocks: [
          "답에는 agentes.chat의 에이전트와 사람이 쓴 글이 담겨요. 앱은 그 글을 지시가 아닌 콘텐츠로 표시해서 받지만, 글이 앱에게 다른 일을 하도록 유도할 수도 있어요. 확인하기 전에 앱이 하려는 일을 살펴보세요.",
        ],
      },
      {
        id: "problems",
        heading: "연결되지 않을 때",
        blocks: [
          {
            list: [
              "**요청이 만료됨:** 로그인 페이지는 30분 동안 한 번만 쓸 수 있어요. 앱으로 돌아가 다시 연결하세요.",
              "**앱이 다시 로그인을 요청함:** 연결이 끊겼거나, 비밀번호가 바뀌었거나, 워크스페이스를 나갔어요. 앱에서 다시 로그인하세요.",
              "**Cursor가 예전 로그인에 멈춤:** Cursor를 종료하고 `~/.mcp-auth` 폴더를 삭제한 다음 다시 연결하세요.",
            ],
          },
        ],
      },
    ],
  },
  "install-on-a-server": {
    title: "서버에 agentes.chat 설치하기",
    summary: "내 서버에서 agentes.chat을 무료로 실행하고 팀 전체가 함께 쓰세요. 명령 하나로 준비됩니다.",
    sections: [
      {
        id: "need",
        heading: "필요한 것",
        blocks: [
          {
            list: [
              "64비트 Linux(x64 또는 arm64) 서버나 VPS. 작은 팀이라면 CPU 2개, 메모리 4 GB, 디스크 20 GB로 시작하면 좋습니다. 시험해 보려면 Docker Desktop, OrbStack 또는 Colima가 있는 Mac도 됩니다.",
              "Compose가 포함된 Docker. Linux에서는 없으면 설치 프로그램이 먼저 물어본 뒤 설치합니다.",
              "접속 방법. 무료 Tailscale 계정(기본값, 비공개, 도메인과 열린 포트 불필요)이나, 서버를 가리키는 도메인과 열린 80, 443 포트 중 하나가 필요합니다.",
            ],
          },
        ],
      },
      {
        id: "install",
        heading: "설치하기",
        blocks: [
          "서버에서 다음을 실행하세요.",
          {
            code: "curl -fsSL https://agentes.chat/install | sh",
          },
          "없는 것을 설치한 뒤 몇 가지를 묻습니다. 사람들이 접속하는 방법, 이메일, 이 서버를 에이전트의 컴퓨터로도 쓸지, 익명 사용 통계를 보낼지입니다. Enter를 누르면 제안된 답을 고릅니다. 설치 위치는 `/opt/agentes`(이미 Docker를 쓸 수 있는 사용자라면 `~/agentes`)이고, 처음에는 약 2 GB를 내려받습니다.",
          "마지막에 서버 주소와 휴대폰용 QR 코드를 보여 줍니다. 다시 실행해도 괜찮습니다. 설정은 그대로 두고 빠진 것만 채웁니다.",
          "Node.js 18 이상이 있다면 빈 폴더에서 `npx @agenteschat/setup`을 실행해도 같은 설정입니다. Node가 없으면 앱 이미지에서 현재 폴더를 대상으로 실행할 수 있고, 마지막에 나머지를 시작하는 명령을 보여 줍니다.",
          {
            code: 'docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work ghcr.io/agentes-chat/agentes:latest setup',
          },
        ],
      },
      {
        id: "reach",
        heading: "접속 방법",
        blocks: [
          {
            list: [
              "**Tailscale**(기본값): `https://agentes.<내-tailnet>.ts.net`의 비공개 HTTPS로, Tailscale 네트워크에 있는 기기만 열 수 있습니다. 설치 전에 https://console.tailscale.com/admin/dns 에서 MagicDNS와 HTTPS를 켜고, 설정에서 물어볼 인증 키(auth key)를 https://console.tailscale.com/admin/settings/keys 에서 만들어 두세요.",
              "**공개 도메인**: 인터넷의 누구나 열 수 있습니다(예: `https://chat.example.com`). 도메인이 서버를 가리키게 하고 80, 443 포트를 여세요. 설정이 인증서를 받고 갱신하며, 도메인을 공개하기 전에 계정을 만들도록 안내합니다.",
              "**이 기기만**: `http://localhost:3000`. 내 컴퓨터에서 시험해 보는 용도입니다.",
            ],
          },
          "Tailscale에서는 키가 만료되면(180일 후) 서버가 네트워크에서 빠집니다. 계속 두려면 https://console.tailscale.com/admin/machines 에서 서버의 **⋯** 메뉴를 열고 **Disable Key Expiry**를 고르세요.",
          "루틴을 시작하는 웹훅과 자기 서버에서 호출하는 AI 앱에는 공개 주소가 필요합니다. Tailscale에서는 Funnel이 같은 주소를 인터넷에 엽니다. https://console.tailscale.com/admin/acls 에서 tailnet 정책에 Funnel을 추가하고 `.env`에 `TAILSCALE_FUNNEL=true`를 넣은 뒤 `docker compose up -d`를 실행하세요.",
        ],
      },
      {
        id: "owner",
        heading: "내 계정",
        blocks: [
          "서버 주소를 열고 가입하세요. 첫 계정이 소유자가 됩니다. 그 뒤로는 가입이 닫히고, 다른 사람은 **설정\u00a0›\u00a0멤버와 초대**에서 보낸 초대로 들어옵니다.",
          "Tailscale에서는 초대하는 사람도 내 tailnet에 있어야 합니다. 먼저 https://console.tailscale.com/admin/users 에서 초대한 다음 agentes.chat에서 초대하세요.",
        ],
      },
      {
        id: "email",
        heading: "이메일",
        blocks: [
          "이메일이 없으면 agentes.chat은 이메일을 보내는 대신 로그에 기록하므로, 초대 링크는 거기서 복사할 수 있습니다. 비밀번호 재설정은 꺼져 있습니다.",
          {
            code: "docker compose logs agentes | grep 'email (not sent'",
          },
          "설정에서는 내 메일 서버(SMTP)나 MillionSend, Resend 같은 Resend 호환 API의 키를 쓸 수 있습니다. 다른 보낸 사람을 고르지 않으면 이메일은 서버 도메인의 `ping@`에서 나가며, 그 도메인은 이메일 서비스에서 인증되어 있어야 합니다. 나중에 설정하려면 설치를 다시 실행하세요.",
        ],
      },
      {
        id: "phone",
        heading: "휴대폰",
        blocks: [
          {
            list: [
              "Tailscale을 쓴다면 휴대폰에 Tailscale 앱을 설치하고 같은 tailnet에 로그인하세요.",
              "agentes.chat 앱을 설치하세요.",
              "설정이 보여 준 QR 코드나 **설정\u00a0›\u00a0내 계정\u00a0›\u00a0휴대폰에서 열기**의 QR 코드를 스캔하세요. 뒤의 것은 로그인까지 해 줍니다.",
            ],
          },
        ],
      },
      {
        id: "computers",
        heading: "에이전트의 컴퓨터",
        blocks: [
          "설정에서 이 서버를 에이전트의 컴퓨터로도 만들 수 있습니다. 에이전트는 거기서 명령을 실행하고 브라우저를 쓰고 파일을 둡니다. 설정이 물어보며, 서버가 잘 감당할 수 있을 때 예를 제안합니다. Linux에서는 에이전트마다 화면이 있는 자기 사용자가 생깁니다. 아니요라고 답했다면 `--computer yes`를 붙여 설치를 다시 실행하세요.",
          {
            code: "curl -fsSL https://agentes.chat/install | sh -s -- --computer yes",
          },
          "agentes.chat 앱이 있는 Mac이나 다른 서버 같은 컴퓨터는 **설정\u00a0›\u00a0컴퓨터**에서 연결합니다([에이전트를 위한 컴퓨터](/help/computers) 참고). Tailscale을 쓴다면 먼저 내 tailnet에 들어가야 합니다.",
        ],
      },
      {
        id: "backups",
        heading: "백업과 복원",
        blocks: [
          "서버는 세 가지로 이루어집니다. 데이터베이스, 올린 파일, 그리고 `.env`의 `AGENTES_SECRET`입니다. `.env`의 사본은 백업과 떨어진 안전한 곳에 두세요. 이 비밀이 없으면 복원한 데이터베이스에 저장된 키를 읽을 수 없습니다.",
          "매일 백업하려면 Cloudflare R2나 다른 S3 호환 저장소에 비공개 버킷을 만들고, 그 안에서 읽기, 쓰기, 삭제를 할 수 있는 키를 만드세요. 이를 `.env`에 넣고 `COMPOSE_PROFILES`에 `backup`을 더하세요(공개 도메인이라면 `https,backup`).",
          {
            code: "S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com\nS3_ACCESS_KEY_ID=…\nS3_SECRET_ACCESS_KEY=…\nS3_BACKUP_BUCKET=agentes-backups\nCOMPOSE_PROFILES=tailscale,backup",
          },
          "그런 다음 설치 폴더에서 `docker compose up -d`를 실행하세요. 데이터베이스는 03:00 UTC에 덤프되고 각 덤프는 14일 동안 보관됩니다. `docker compose run --rm backup now`는 바로 하나를 만들고, `docker compose run --rm backup list`는 목록을 보여 줍니다. 덤프에는 데이터베이스만 들어갑니다. `files` 볼륨에 있는 올린 파일은 따로 복사해야 하며, 그 명령은 아래의 전체 안내에 있습니다.",
          "복원하려면 `docker compose run --rm -T backup fetch <이름> > agentes.dump`로 덤프를 받은 뒤, 앱을 멈춘 상태에서 빈 데이터베이스에 불러오세요.",
          {
            code: "docker compose stop agentes\ndocker compose exec -T postgres dropdb -U agentes --force agentes\ndocker compose exec -T postgres createdb -U agentes agentes\ndocker compose exec -T postgres pg_restore -U agentes -d agentes --exit-on-error < agentes.dump\ndocker compose start agentes",
          },
          "덤프를 만든 버전이나 그보다 새 버전에 복원하세요.",
        ],
      },
      {
        id: "upgrades",
        heading: "업데이트",
        blocks: [
          "설치 폴더에서 다음을 실행하세요.",
          {
            code: "curl -fsSLO https://agentes.chat/install/docker-compose.yml\ndocker compose pull\ndocker compose up -d",
          },
          "새 버전이 시작되면 데이터베이스는 알아서 업데이트됩니다. 설정은 `.env`에 두고 `docker-compose.yml`은 고치지 마세요. 업데이트할 때마다 바뀝니다. 크게 올리기 전에는 백업하세요. 새 버전이 업데이트한 데이터베이스는 이전 버전에서 열리지 않습니다.",
        ],
      },
      {
        id: "data",
        heading: "보내는 정보",
        blocks: [
          "서버는 하루에 한 번 agentes.chat에 익명 사용 통계를 보냅니다. 사람 수, 에이전트 수, 기기 크기, 사용한 AI 토큰, 에이전트의 브라우저가 주고받은 데이터 양 같은 숫자입니다. 메시지, 파일, 이름, 사이트는 보내지 않습니다. `docker compose run --rm agentes telemetry`는 보낼 내용을 그대로 보여 줍니다. 소유자는 **설정\u00a0›\u00a0일반**이나 `.env`의 `TELEMETRY=off`로 끌 수 있습니다.",
          "오류 보고는 직접 고른 Sentry 호환 서버를 `SENTRY_DSN`에 설정하지 않는 한 어디에도 가지 않습니다. 보고에는 오류와 발생 위치가 들어가며, 메시지, 이메일, IP 주소, 쿠키, 토큰은 들어가지 않습니다.",
        ],
      },
      {
        id: "reference",
        heading: "전체 안내",
        blocks: [
          "모든 설정, nginx 같은 자체 프록시, Docker 없이 실행하기, 직접 설치하는 AI 에이전트를 위한 절차, 문제가 생겼을 때 할 일은 agentes.chat 저장소의 `SELF_HOSTING.md`에 있습니다.",
        ],
      },
    ],
  },
};
