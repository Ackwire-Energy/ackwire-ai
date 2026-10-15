import { Avatar, Logo, Mention, Message, MessageText } from "@agenteschat/ui";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AuthSky } from "@/components/Sky";

/**
 * Split screen of telas/Entrar and Cadastro: the landing's pixel sky aside
 * (calm behind the text and messages, a big agent rising at the corner), the
 * form on the right.
 */
export function AuthLayout({ aside, children }: { aside: "demo" | "steps"; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const calm = () => Array.from(panel.current?.querySelectorAll("[data-calm]") ?? []);
  return (
    <div className="auth">
      <aside className="auth__aside" aria-hidden="true" ref={panel}>
        <AuthSky calm={calm} />
        <span data-calm className="auth__logo">
          <Logo size={28} />
        </span>
        {aside === "demo" ? <DemoChat /> : <SignupSteps />}
        <AgentAvatar name="" size="xl" className="auth__giant" />
      </aside>
      <main className="auth__main">{children}</main>
    </div>
  );
}

function DemoChat() {
  const { t } = useTranslation();
  return (
    <div className="auth__demo">
      <p className="auth__tagline" data-calm>
        {t("auth.tagline")}
      </p>
      <Message avatar={<Avatar name="Marina" />} author="Marina" time="09:12" data-calm>
        <MessageText>
          <Mention>@Lia</Mention> {t("auth.demoAsk")}
        </MessageText>
      </Message>
      <Message avatar={<AgentAvatar name="Lia" />} author="Lia" time="09:13" agent data-calm>
        <MessageText>{t("auth.demoReply")}</MessageText>
      </Message>
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
        <li key={title} data-calm>
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
