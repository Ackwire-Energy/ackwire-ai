import { Avatar, Logo, Mention, Message, MessageText } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";

/** Split screen of telas/Entrar and Cadastro: illustration aside, form on the right. */
export function AuthLayout({ aside, children }: { aside: "demo" | "steps"; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__aside" aria-hidden="true">
        <Logo size={28} />
        {aside === "demo" ? <DemoChat /> : <SignupSteps />}
      </aside>
      <main className="auth__main">{children}</main>
    </div>
  );
}

function DemoChat() {
  const { t } = useTranslation();
  return (
    <div className="auth__demo">
      <Message avatar={<Avatar name="Marina" />} author="Marina" time="09:12">
        <MessageText>
          <Mention>@Lia</Mention> {t("auth.demoAsk")}
        </MessageText>
      </Message>
      <Message avatar={<AgentAvatar name="Lia" />} author="Lia" time="09:13" agent>
        <MessageText>{t("auth.demoReply")}</MessageText>
      </Message>
      <p className="auth__tagline">{t("auth.tagline")}</p>
    </div>
  );
}

function SignupSteps() {
  const { t } = useTranslation();
  const steps = [
    [t("auth.steps.org"), t("auth.steps.orgDesc")],
    [t("auth.steps.context"), t("auth.steps.contextDesc")],
    [t("auth.steps.agent"), t("auth.steps.agentDesc")],
    [t("auth.steps.invite"), t("auth.steps.inviteDesc")],
  ];
  return (
    <ol className="auth__steps">
      {steps.map(([title, desc], i) => (
        <li key={title}>
          <span className="auth__step-n">{i + 1}</span>
          <span>
            <b>{title}</b>
            <br />
            <span className="muted">{desc}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Centered card of telas/Convite and Onboarding. */
export function CenteredLayout({ narrow, children }: { narrow?: boolean; children: ReactNode }) {
  return (
    <div className="center">
      <Logo size={24} />
      <main className={narrow ? "center__card center__card--narrow" : "center__card"}>{children}</main>
    </div>
  );
}
