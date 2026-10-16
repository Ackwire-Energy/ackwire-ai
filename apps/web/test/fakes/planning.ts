/**
 * Test fake — issues, routines and calendar (D28; backend phase 6).
 * Mirrors these endpoints (shapes in `api/types.ts`):
 * - Issues: `GET …/issues?q`, `GET …/issues/{number}`, `POST …/issues`, `PATCH …/issues/{id}`,
 *   `PUT …/issues/{id}/criteria/{criterionId} { done }`, `GET|POST …/issues/{id}/activity`,
 *   `POST …/issues/{id}/ask-agent { agentId }` (assigns, moves to "Em andamento", starts the run).
 * - Routines: `GET|POST …/routines`, `POST …/routines/parse-schedule { phrase }` → cron + description in the
 *   workspace time zone, `PATCH …/routines/{id} { active }`, `POST …/routines/{id}/run`, `GET …/routines/{id}/runs`.
 * - Calendar: `GET …/calendar?from&to` → events, routine runs, issue deadlines and agent proposals;
 *   `POST …/calendar/events`, `POST …/calendar/proposals/{id}/confirm|dismiss`.
 * Nothing runs: "Rodar agora" and "Pedir à Ada" only change local state. Seeded in development only.
 */
import { nextOccurrences } from "@agenteschat/ui";
import type { ApiClient } from "@/api/client";
import type {
  Actor,
  ApiRule,
  CalendarEvent,
  CalendarProposal,
  Issue,
  IssueActivity,
  Routine,
  RoutineRun,
  RuleInfo,
  ScheduleParse,
} from "@/api/types";
import { defaultRule, fromApiRule, phraseToRule, ruleToPhrase, toApiRule } from "@/lib/recurrence";
import { clone, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

const DAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const DAY_LABEL = [
  "Todo domingo",
  "Toda segunda-feira",
  "Toda terça-feira",
  "Toda quarta-feira",
  "Toda quinta-feira",
  "Toda sexta-feira",
  "Todo sábado",
];
const pad = (n: number) => String(n).padStart(2, "0");

/** The mock's stand-in for the backend parser: a few Portuguese phrasings. */
export function parseSchedulePhrase(phrase: string, timezone = "America/Sao_Paulo"): ScheduleParse {
  const t = phrase.trim().toLowerCase();
  if (!t) return { ok: false, error: "Escreva quando a rotina deve rodar." };
  const hm = t.match(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?/);
  const hour = hm ? Number(hm[1]) : 9;
  const minute = hm?.[2] ? Number(hm[2]) : 0;
  if (hour > 23 || minute > 59) return { ok: false, error: "Horário inválido." };
  const at = `${pad(hour)}:${pad(minute)}`;
  const day = DAYS.findIndex((d) => t.includes(d));
  const monthDay = t.match(/dia\s+(\d{1,2})\b/);
  if (/dias? úteis|dia útil/.test(t)) {
    return { ok: true, cron: `${minute} ${hour} * * 1-5`, description: `De segunda a sexta, às ${at}`, timezone };
  }
  if (day >= 0) {
    return { ok: true, cron: `${minute} ${hour} * * ${day}`, description: `${DAY_LABEL[day]}, às ${at}`, timezone };
  }
  if (monthDay && Number(monthDay[1]) >= 1 && Number(monthDay[1]) <= 28) {
    return {
      ok: true,
      cron: `${minute} ${hour} ${Number(monthDay[1])} * *`,
      description: `Todo dia ${Number(monthDay[1])}, às ${at}`,
      timezone,
    };
  }
  if (/todo dia|todos os dias|diariamente/.test(t)) {
    return { ok: true, cron: `${minute} ${hour} * * *`, description: `Todos os dias, às ${at}`, timezone };
  }
  return { ok: false, error: "Não entendi. Tente “toda segunda às 9h” ou “dias úteis às 18h”." };
}

/** Next time a `m h dom * dow` cron fires after `from` (local time). */
export function nextCronRun(cron: string, from: Date): Date | null {
  const [m, h, dom, , dow] = cron.split(" ");
  const minute = Number(m);
  const hour = Number(h);
  if (Number.isNaN(minute) || Number.isNaN(hour)) return null;
  const okDay = (d: Date) => {
    if (dom && dom !== "*" && d.getDate() !== Number(dom)) return false;
    if (dow === "1-5") return d.getDay() >= 1 && d.getDay() <= 5;
    if (dow && dow !== "*") return d.getDay() === Number(dow);
    return true;
  };
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 0; i < 400; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hour, minute);
    if (c > from && okDay(c)) return c;
  }
  return null;
}

export function startOfWeek(d: Date) {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

interface Store {
  issues: Issue[];
  activity: Map<string, IssueActivity[]>;
  routines: Routine[];
  runs: Map<string, RoutineRun[]>;
  events: CalendarEvent[];
  proposals: CalendarProposal[];
}

export function createMockPlanning(
  ctx: MockContext,
  record: (method: string, ...args: unknown[]) => void = () => {},
): Pick<ApiClient, "issues" | "routines" | "calendar"> {
  const me = async (): Promise<Actor> => ({ type: "person", id: (await ctx.lookup.me())?.user.id ?? "me" });
  const store = perOrg<Store>(async (orgId) => {
    const s: Store = { issues: [], activity: new Map(), routines: [], runs: new Map(), events: [], proposals: [] };
    if (!ctx.seed) return s;
    const [agents, members, channels] = await Promise.all([
      ctx.lookup.agents(orgId),
      ctx.lookup.members(orgId),
      ctx.lookup.channels(orgId),
    ]);
    const now = ctx.now();
    const agent = (i: number): Actor => ({ type: "agent", id: agents[i % Math.max(1, agents.length)]?.id ?? "agent" });
    const person = (i: number): Actor => ({
      type: "person",
      id: members[i % Math.max(1, members.length)]?.userId ?? "me",
    });
    const day = (offset: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const channel = channels[0]?.id ?? null;
    let n = 125;
    const issue = (over: Partial<Issue> & Pick<Issue, "title" | "status">): Issue => ({
      id: mockId("iss"),
      number: ++n,
      description: "",
      priority: "normal",
      assignee: null,
      labels: [],
      dueDate: null,
      criteria: [],
      createdBy: person(0),
      source: { type: "manual" },
      channelId: null,
      pullRequests: [],
      artifacts: [],
      createdAt: minutesAgo(now, 3000 - n),
      updatedAt: minutesAgo(now, 600 - n),
      ...over,
    });
    s.issues.push(
      issue({ title: "Organizar o roadmap do trimestre", status: "done", assignee: agent(3) }),
      issue({
        title: "Resumo semanal de erros do Sentry no #eng",
        status: "done",
        assignee: agent(1),
        labels: ["ops"],
      }),
      issue({
        title: "Login devolve 401 depois do deploy das 9h",
        status: "in_review",
        assignee: agent(0),
        priority: "high",
        labels: ["bug"],
        dueDate: day(0),
        pullRequests: [{ number: 42, url: "https://github.com/acme/app/pull/42", openedBy: agent(0) }],
      }),
      issue({
        title: "Timeout no agendamento em horários de pico",
        status: "in_progress",
        assignee: agent(0),
        labels: ["bug"],
        dueDate: day(2),
        pullRequests: [{ number: 44, url: "https://github.com/acme/app/pull/44", openedBy: agent(0) }],
      }),
      issue({ title: "Revisar textos do onboarding", status: "in_progress", assignee: person(1), labels: ["produto"] }),
      issue({
        title: "Confirmação do agendamento por WhatsApp",
        status: "todo",
        priority: "high",
        assignee: person(1),
        labels: ["produto", "agendamento"],
        dueDate: day(4),
        description:
          "31 reviews da semana pedem confirmação por WhatsApp; 12 citam faltas de pacientes. Enviar uma mensagem 24 h antes da consulta com botões para confirmar ou remarcar.",
        criteria: [
          "Mensagem enviada 24 h antes da consulta, no fuso da clínica",
          "Botões “Confirmar” e “Remarcar”; a resposta atualiza a agenda",
          "Paciente sem WhatsApp recebe SMS",
          "Relatório semanal de faltas no Drive",
        ].map((text) => ({ id: mockId("crit"), text, done: false })),
        createdBy: person(1),
        source: channel ? { type: "message", channelId: channel, messageId: "m-1" } : { type: "manual" },
        channelId: channel,
      }),
      issue({
        title: "Tabela de concorrentes atualizada",
        status: "todo",
        assignee: agent(2),
        labels: ["pesquisa"],
        dueDate: day(10),
      }),
    );
    const wa = s.issues.find((i) => i.criteria.length) as Issue;
    s.activity.set(wa.id, [
      {
        id: mockId("act"),
        kind: "comment",
        author: person(1),
        text: "Os números estão na tabela de reviews. Prioridade alta para o trimestre.",
        createdAt: minutesAgo(now, 1400),
      },
    ]);
    const target = channel ? ({ type: "channel", channelId: channel } as const) : ({ type: "dm" } as const);
    const routine = (over: Partial<Routine> & Pick<Routine, "name" | "agentId" | "trigger">): Routine => {
      const r: Routine = {
        id: mockId("rt"),
        prompt: "",
        target,
        active: true,
        nextRunAt: null,
        running: false,
        lastRun: null,
        budgetUsedPercent: null,
        createdAt: minutesAgo(now, 20000),
        ...over,
      };
      if (r.active && r.trigger.type === "schedule")
        r.nextRunAt = nextCronRun(r.trigger.cron, now)?.toISOString() ?? null;
      return r;
    };
    const sched = (phrase: string) => {
      const p = parseSchedulePhrase(phrase) as Extract<ScheduleParse, { ok: true }>;
      return { type: "schedule" as const, phrase, cron: p.cron, timezone: p.timezone, description: p.description };
    };
    const run = (mins: number, summary: string, status: RoutineRun["status"] = "ok"): RoutineRun => ({
      id: mockId("run"),
      at: minutesAgo(now, mins),
      status,
      summary,
    });
    const weekly = routine({
      name: "Resumo da semana",
      agentId: agent(3).id,
      prompt: "Resuma o que aconteceu na semana: decisões, issues fechadas e o que ficou pendente.",
      trigger: sched("toda segunda às 9h"),
    });
    const errors = routine({
      name: "Erros do Sentry do dia",
      agentId: agent(1).id,
      trigger: sched("dias úteis às 18h"),
    });
    const pr = routine({
      name: "Revisar PR aberto",
      agentId: agent(0).id,
      target: { type: "artifact" },
      trigger: { type: "event", event: "github.pr_opened" },
    });
    const monthly = routine({
      name: "Relatório mensal de reviews",
      agentId: agent(2).id,
      target: { type: "artifact" },
      trigger: sched("dia 1 às 8h"),
      active: false,
    });
    s.routines.push(weekly, errors, pr, monthly);
    s.runs.set(weekly.id, [
      run(7 * 1440, "Resumo postado no canal"),
      run(14 * 1440, "Resumo postado no canal"),
      run(21 * 1440, "Orçamento do mês esgotado", "skipped"),
      run(28 * 1440, "Resumo postado no canal"),
    ]);
    s.runs.set(errors.id, [run(1440, "Abriu 1 issue")]);
    s.runs.set(pr.id, [run(180, "Revisou o PR #42")]);
    s.runs.set(monthly.id, [run(13 * 1440, "Relatório no Drive")]);
    for (const r of s.routines) r.lastRun = s.runs.get(r.id)?.[0] ?? null;

    const monday = startOfWeek(now);
    const at = (dayOffset: number, h: number, m = 0) =>
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + dayOffset, h, m).toISOString();
    const event = (over: Partial<CalendarEvent> & Pick<CalendarEvent, "title" | "start" | "end">): CalendarEvent => ({
      id: mockId("ev"),
      description: "",
      allDay: false,
      timezone: "America/Sao_Paulo",
      recurrence: "none",
      participants: [],
      rsvp: [],
      channelId: null,
      issueId: null,
      createdBy: person(0),
      ...over,
    });
    s.events.push(
      event({
        title: "Daily de produto",
        start: at(0, 10),
        end: at(0, 11),
        description: "Pauta preparada no canal.",
        participants: [person(0), person(1), agent(3)],
      }),
      event({ title: "Revisão de design", start: at(1, 14), end: at(1, 15, 30), participants: [person(1), person(2)] }),
      event({
        title: "Retro da sprint",
        start: at(4, 11),
        end: at(4, 12),
        participants: [person(0), person(2), agent(0)],
      }),
    );
    s.proposals.push({
      id: mockId("prop"),
      agentId: agent(3).id,
      title: "Revisão do roadmap",
      start: at(3, 15),
      end: at(3, 15, 45),
      participants: [person(0), person(1), person(2)],
      note: "livre para todos",
      status: "pending",
    });
    return s;
  });

  const findIssue = async (orgId: string, id: string) => {
    const i = (await store(orgId)).issues.find((x) => x.id === id);
    if (!i) throw new MockNotFoundError("Issue não encontrada.");
    return i;
  };
  const log = async (orgId: string, issue: Issue, entry: Omit<IssueActivity, "id" | "createdAt">) => {
    const s = await store(orgId);
    const list = s.activity.get(issue.id) ?? [];
    const a: IssueActivity = { ...entry, id: mockId("act"), createdAt: ctx.now().toISOString() };
    list.push(a);
    s.activity.set(issue.id, list);
    issue.updatedAt = a.createdAt;
    return a;
  };
  const findRoutine = async (orgId: string, id: string) => {
    const r = (await store(orgId)).routines.find((x) => x.id === id);
    if (!r) throw new MockNotFoundError("Rotina não encontrada.");
    return r;
  };

  return {
    issues: {
      list: async (orgId, filters = {}) => {
        const q = filters.q?.trim().toLowerCase();
        return clone(
          (await store(orgId)).issues
            .filter((i) => !q || `${i.title} #${i.number}`.toLowerCase().includes(q))
            .sort((a, b) => b.number - a.number),
        );
      },
      get: async (orgId, number) => {
        const i = (await store(orgId)).issues.find((x) => x.number === number);
        if (!i) throw new MockNotFoundError("Issue não encontrada.");
        return clone(i);
      },
      create: async (orgId, input) => {
        const s = await store(orgId);
        const at = ctx.now().toISOString();
        const issue: Issue = {
          id: mockId("iss"),
          number: Math.max(0, ...s.issues.map((i) => i.number)) + 1,
          title: input.title.trim(),
          description: input.description?.trim() ?? "",
          status: "todo",
          priority: input.priority ?? "normal",
          assignee: input.assignee ?? null,
          labels: input.labels ?? [],
          dueDate: input.dueDate ?? null,
          criteria: (input.criteria ?? []).map((text) => ({ id: mockId("crit"), text, done: false })),
          createdBy: await me(),
          source: { type: "manual" },
          channelId: null,
          pullRequests: [],
          artifacts: [],
          createdAt: at,
          updatedAt: at,
        };
        s.issues.push(issue);
        return clone(issue);
      },
      update: async (orgId, id, patch) => {
        const i = await findIssue(orgId, id);
        const author = await me();
        if (patch.status && patch.status !== i.status) {
          // Same words as the backend (packages/engine/src/issues.ts).
          const words = {
            todo: "A fazer",
            in_progress: "Em andamento",
            in_review: "Em revisão",
            done: "Concluída",
            canceled: "Cancelada",
          };
          await log(orgId, i, {
            kind: "event",
            author,
            event: "status_changed",
            text: `mudou o status para ${words[patch.status]}`,
          });
        }
        Object.assign(i, patch, { updatedAt: ctx.now().toISOString() });
        return clone(i);
      },
      setCriterion: async (orgId, id, criterionId, done) => {
        const i = await findIssue(orgId, id);
        const c = i.criteria.find((x) => x.id === criterionId);
        if (!c) throw new MockNotFoundError("Critério não encontrado.");
        c.done = done;
        return clone(i);
      },
      activity: async (orgId, id) => clone((await store(orgId)).activity.get(id) ?? []),
      comment: async (orgId, id, text) =>
        clone(await log(orgId, await findIssue(orgId, id), { kind: "comment", author: await me(), text: text.trim() })),
      askAgent: async (orgId, id, agentId) => {
        const i = await findIssue(orgId, id);
        i.assignee = { type: "agent", id: agentId };
        i.status = "in_progress";
        const agentName = (await ctx.lookup.agents(orgId)).find((a) => a.id === agentId)?.name ?? "o agente";
        await log(orgId, i, {
          kind: "event",
          author: await me(),
          event: "agent_asked",
          text: `pediu a ${agentName} para implementar`,
        });
        return clone(i);
      },
    },
    routines: {
      list: async (orgId) => clone((await store(orgId)).routines),
      parseSchedule: async (_orgId, phrase, timezone) => parseSchedulePhrase(phrase, timezone),
      parseRule: async (_orgId, phrase, timezone = "America/Sao_Paulo") => {
        const today = ctx.now();
        const base = defaultRule(timezone, today);
        const rule = phraseToRule(phrase, base);
        if (!rule) return { ok: false, error: "Não entendi. Tente “toda segunda às 9h” ou “dias úteis às 18h”." };
        return ruleInfo(toApiRule(rule), today);
      },
      describeRule: async (_orgId, rule) => ruleInfo(rule, ctx.now()),
      create: async (orgId, input) => {
        const s = await store(orgId);
        let trigger: Routine["trigger"];
        if (input.trigger.type === "schedule") trigger = scheduleOf(input.trigger);
        else if (input.trigger.type === "once")
          trigger = {
            type: "once",
            at: input.trigger.at,
            timezone: input.trigger.timezone ?? "America/Sao_Paulo",
            description: input.trigger.at,
          };
        else trigger = input.trigger;
        const agents = await ctx.lookup.agents(orgId);
        const r: Routine = {
          id: mockId("rt"),
          name: input.name?.trim() || `Rotina de ${agents.find((a) => a.id === input.agentId)?.name ?? "agente"}`,
          agentId: input.agentId,
          prompt: input.prompt,
          target: input.target,
          trigger,
          active: true,
          nextRunAt: trigger.type === "schedule" ? (nextCronRun(trigger.cron, ctx.now())?.toISOString() ?? null) : null,
          running: false,
          lastRun: null,
          budgetUsd: input.budgetUsd ?? null,
          budgetUsedPercent: input.budgetUsd == null ? null : 0,
          createdAt: ctx.now().toISOString(),
        };
        s.routines.push(r);
        return clone(r);
      },
      update: async (orgId, id, patch) => {
        record("routines.update", id, patch);
        const r = await findRoutine(orgId, id);
        if (patch.name !== undefined) r.name = patch.name;
        if (patch.prompt !== undefined) r.prompt = patch.prompt;
        if (patch.agentId !== undefined) r.agentId = patch.agentId;
        if (patch.target !== undefined) r.target = patch.target;
        if (patch.budgetUsd !== undefined) r.budgetUsd = patch.budgetUsd;
        if (patch.active !== undefined) r.active = patch.active;
        if (patch.trigger?.type === "schedule") r.trigger = scheduleOf(patch.trigger);
        else if (patch.trigger?.type === "once")
          r.trigger = {
            type: "once",
            at: patch.trigger.at,
            timezone: patch.trigger.timezone ?? "America/Sao_Paulo",
            description: r.trigger.type === "once" ? r.trigger.description : patch.trigger.at,
          };
        else if (patch.trigger) r.trigger = patch.trigger;
        r.nextRunAt =
          r.active && r.trigger.type === "schedule"
            ? (nextCronRun(r.trigger.cron, ctx.now())?.toISOString() ?? null)
            : null;
        return clone(r);
      },
      remove: async (orgId, id) => {
        record("routines.remove", id);
        await findRoutine(orgId, id);
        const s = await store(orgId);
        s.routines = s.routines.filter((x) => x.id !== id);
      },
      duplicate: async (orgId, id) => {
        record("routines.duplicate", id);
        const r = await findRoutine(orgId, id);
        const copy: Routine = {
          ...clone(r),
          id: mockId("rt"),
          name: `${r.name} (cópia)`,
          active: false,
          nextRunAt: null,
          running: false,
          lastRun: null,
          createdAt: ctx.now().toISOString(),
        };
        (await store(orgId)).routines.push(copy);
        return clone(copy);
      },
      setActive: async (orgId, id, active) => {
        const r = await findRoutine(orgId, id);
        r.active = active;
        r.nextRunAt =
          active && r.trigger.type === "schedule"
            ? (nextCronRun(r.trigger.cron, ctx.now())?.toISOString() ?? null)
            : null;
        return clone(r);
      },
      runNow: async (orgId, id) => {
        const r = await findRoutine(orgId, id);
        r.running = true;
        return clone(r);
      },
      runs: async (orgId, id) => {
        await findRoutine(orgId, id);
        return clone((await store(orgId)).runs.get(id) ?? []);
      },
    },
    calendar: {
      range: async (orgId, from, to) => {
        const s = await store(orgId);
        const a = new Date(from);
        const b = new Date(to);
        const inRange = (iso: string) => new Date(iso) >= a && new Date(iso) < b;
        const routines: Awaited<ReturnType<ApiClient["calendar"]["range"]>>["routines"] = [];
        for (const r of s.routines) {
          if (!r.active || r.trigger.type !== "schedule") continue;
          let next = nextCronRun(r.trigger.cron, new Date(a.getTime() - 60_000));
          while (next && next < b) {
            routines.push({
              routineId: r.id,
              name: r.name,
              agentId: r.agentId,
              at: next.toISOString(),
              target: r.target,
            });
            next = nextCronRun(r.trigger.cron, next);
          }
        }
        const day = (d: string) => new Date(`${d}T12:00:00`);
        return clone({
          events: expandEvents(s.events, a, b),
          routines,
          deadlines: s.issues
            .filter(
              (i) =>
                i.dueDate &&
                i.status !== "done" &&
                i.status !== "canceled" &&
                day(i.dueDate) >= a &&
                day(i.dueDate) < b,
            )
            .map((i) => ({ issueId: i.id, number: i.number, title: i.title, date: i.dueDate as string })),
          proposals: s.proposals.filter((p) => inRange(p.start)),
        });
      },
      create: async (orgId, input) => {
        const e: CalendarEvent = {
          id: mockId("ev"),
          title: input.title.trim(),
          description: input.description ?? "",
          start: input.start,
          end: input.end,
          allDay: input.allDay ?? false,
          timezone: input.timezone ?? "America/Sao_Paulo",
          recurrence: input.recurrence,
          participants: input.participants,
          rsvp: input.participants
            .filter((p) => p.type === "person")
            .map((p) => ({ ...p, status: "needs_action" as const })),
          channelId: input.channelId ?? null,
          issueId: input.issueId ?? null,
          createdBy: await me(),
          rule: input.rule ?? null,
          location: input.location ?? null,
          exdates: [],
        };
        record("calendar.create", input);
        (await store(orgId)).events.push(e);
        return clone(e);
      },
      confirmProposal: async (orgId, id) => {
        const s = await store(orgId);
        const p = s.proposals.find((x) => x.id === id);
        if (!p) throw new MockNotFoundError("Proposta não encontrada.");
        s.proposals = s.proposals.filter((x) => x.id !== id);
        const e: CalendarEvent = {
          id: mockId("ev"),
          title: p.title,
          description: "",
          start: p.start,
          end: p.end,
          allDay: false,
          timezone: "America/Sao_Paulo",
          recurrence: "none",
          participants: [...p.participants, { type: "agent", id: p.agentId }],
          rsvp: [],
          channelId: null,
          issueId: null,
          createdBy: await me(),
        };
        s.events.push(e);
        return clone(e);
      },
      dismissProposal: async (orgId, id) => {
        const s = await store(orgId);
        s.proposals = s.proposals.filter((x) => x.id !== id);
      },
      update: async (orgId, id, patch, series) => {
        record("calendar.update", id, patch, series);
        const s = await store(orgId);
        const master = s.events.find((e) => e.id === id);
        if (!master) throw new MockNotFoundError("Evento não encontrado.");
        if (!series || series.scope === "all" || !master.rule || master.rule.freq === "once") {
          // A whole series moves by how much this occurrence moved.
          if (series && patch.start && master.rule && master.rule.freq !== "once") {
            const delta = new Date(patch.start).getTime() - new Date(series.occurrenceStart).getTime();
            const dur = patch.end
              ? new Date(patch.end).getTime() - new Date(patch.start).getTime()
              : new Date(master.end).getTime() - new Date(master.start).getTime();
            const start = new Date(new Date(master.start).getTime() + delta);
            Object.assign(master, {
              ...patch,
              start: start.toISOString(),
              end: new Date(start.getTime() + dur).toISOString(),
            });
            master.rule = { ...master.rule, start: localYmd(start), times: [localHm(start)] };
          } else Object.assign(master, patch);
          return clone(master);
        }
        const occurrence = new Date(series.occurrenceStart);
        if (series.scope === "this") {
          master.exdates = [...(master.exdates ?? []), localYmd(occurrence)];
          const dur = new Date(master.end).getTime() - new Date(master.start).getTime();
          const override: CalendarEvent = {
            ...clone(master),
            start: occurrence.toISOString(),
            end: new Date(occurrence.getTime() + dur).toISOString(),
            ...patch,
            id: mockId("ev"),
            rule: null,
            exdates: [],
            seriesId: master.id,
            occurrenceStart: series.occurrenceStart,
          };
          s.events.push(override);
          return clone(override);
        }
        // "Este e os próximos": the series ends the day before; a new one starts here.
        const until = localYmd(new Date(occurrence.getTime() - 86_400_000));
        const rule = master.rule;
        master.rule = { ...rule, until };
        const start = new Date(patch.start ?? series.occurrenceStart);
        const dur = new Date(patch.end ?? master.end).getTime() - new Date(patch.start ?? master.start).getTime();
        const next: CalendarEvent = {
          ...clone(master),
          ...patch,
          id: mockId("ev"),
          start: start.toISOString(),
          end: new Date(start.getTime() + dur).toISOString(),
          rule: { ...(patch.rule ?? rule), start: localYmd(start), times: [localHm(start)], until: rule.until ?? null },
          exdates: [],
        };
        s.events.push(next);
        return clone(next);
      },
      remove: async (orgId, id, series) => {
        record("calendar.remove", id, series);
        const s = await store(orgId);
        const master = s.events.find((e) => e.id === id);
        if (!master) throw new MockNotFoundError("Evento não encontrado.");
        if (!series || series.scope === "all" || !master.rule) {
          s.events = s.events.filter((e) => e.id !== id && e.seriesId !== id);
          return;
        }
        const day = localYmd(new Date(series.occurrenceStart));
        if (series.scope === "this") master.exdates = [...(master.exdates ?? []), day];
        else
          master.rule = {
            ...master.rule,
            until: localYmd(new Date(new Date(series.occurrenceStart).getTime() - 86_400_000)),
          };
      },
    },
  };
}

/** A schedule trigger from a phrase or a rule (the rule's phrase gives the mock its cron and description). */
function scheduleOf(
  input: { type: "schedule"; phrase: string; timezone?: string } | { type: "schedule"; rule: ApiRule },
): Routine["trigger"] {
  if ("rule" in input) {
    const rule = fromApiRule(input.rule, localYmd(new Date()));
    const p = parseSchedulePhrase(ruleToPhrase(rule), rule.timezone);
    return {
      type: "schedule",
      phrase: null,
      rule: input.rule,
      cron: p.ok ? p.cron : "0 9 * * *",
      timezone: rule.timezone,
      description: p.ok ? p.description : ruleToPhrase(rule),
    };
  }
  const p = parseSchedulePhrase(input.phrase, input.timezone);
  if (!p.ok) throw new Error(p.error);
  return { type: "schedule", phrase: input.phrase, cron: p.cron, timezone: p.timezone, description: p.description };
}

/** The mock's `parse-rule` / `describe-rule` answer. */
function ruleInfo(api: ApiRule, now: Date): RuleInfo {
  const rule = fromApiRule(api, localYmd(now));
  const phrase = ruleToPhrase(rule);
  const p = parseSchedulePhrase(phrase, rule.timezone);
  return {
    ok: true,
    rule: api,
    description: p.ok ? p.description : phrase,
    cron: p.ok ? p.cron : "",
    nextRuns: nextOccurrences(rule, now, 5).map((d) => d.toISOString()),
  };
}

const localYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Events in [a, b): single ones that overlap it, and each occurrence of the recurring ones. */
function expandEvents(events: CalendarEvent[], a: Date, b: Date): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of events) {
    const start = new Date(e.start);
    const end = new Date(e.end);
    if (!e.rule || e.rule.freq === "once") {
      if (start < b && end > a) out.push(e);
      continue;
    }
    const dur = end.getTime() - start.getTime();
    const skip = new Set(e.exdates ?? []);
    for (const at of nextOccurrences(fromApiRule(e.rule, localYmd(start)), new Date(a.getTime() - dur), 400)) {
      if (at >= b) break;
      if (skip.has(localYmd(at))) continue;
      out.push({
        ...e,
        start: at.toISOString(),
        end: new Date(at.getTime() + dur).toISOString(),
        seriesId: e.id,
        occurrenceStart: at.toISOString(),
      });
    }
  }
  return out;
}
