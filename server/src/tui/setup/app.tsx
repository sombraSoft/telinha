// The setup screens' root: header, the step sidebar, the card area and the
// key help. Which card shows comes from the setup state (a question or the
// Review) or from here (the welcome card, the install, the doctor report).
// Keys no screen used end here: Tab (sidebar), Esc / ← (back), Ctrl+C.
import { type Accessor, createEffect, createSignal, Match, on, Show, Switch, useContext } from 'solid-js';
import { type ApplyHooks, TASKS, type TaskId } from '../../cli/setup/apply.ts';
import type { StepId } from '../../cli/setup/model.ts';
import type { WithTerminal } from '../../cli/setup/steps.ts';
import type { SetupUiContext, SetupUiResult } from '../../cli/setup/ui.ts';
import type { Locale } from '../../cli/strings.ts';
import { CHECKS } from '../../doctor/checks.ts';
import type { Check } from '../../doctor/types.ts';
import { DoctorScreen } from '../doctor/screen.tsx';
import { isCtrlC, useKeys } from '../keys.ts';
import { LocaleCtx, useT } from '../strings.ts';
import { Footer, Header, Sidebar, type SidebarStep } from '../ui/chrome.tsx';
import { ChromeCtx, createChrome, useLayout } from '../ui/layout.ts';
import { ApplyScreen } from './screens/apply.tsx';
import { QuestionScreen } from './screens/question.tsx';
import { ReviewScreen, stepBadge } from './screens/review.tsx';
import { WelcomeScreen } from './screens/welcome.tsx';
import { type ApplyStore, createApplyStore, createStateStore, type StateStore } from './store.ts';
import { useS } from './strings.ts';

export interface SetupAppProps {
  c: SetupUiContext;
  done(r: SetupUiResult): void;
  /** The runtime's terminal hand-off (sudo asks for a password there); plain call without one. */
  withTerminal?: WithTerminal;
  /** Keeps the runtime's language in step with the screens'. */
  setLocale?(l: Locale): void;
  /** The doctor report's checks; tests pass their own. */
  checks?: readonly Check[];
}

export function SetupApp(p: SetupAppProps) {
  const store = createStateStore(p.c.state);
  const apply = createApplyStore(p.c.tasks);
  const chrome = createChrome();
  createEffect(() => p.setLocale?.(store.locale()));
  return (
    <LocaleCtx.Provider value={store.locale}>
      <ChromeCtx.Provider value={chrome}>
        <Root {...p} store={store} apply={apply} />
      </ChromeCtx.Provider>
    </LocaleCtx.Provider>
  );
}

type Place = 'welcome' | 'questions' | 'apply' | 'doctor';

function Root(p: SetupAppProps & { store: StateStore; apply: ApplyStore }) {
  const t = useT();
  const s = useS();
  const L = useLayout();
  const chrome = useContext(ChromeCtx);
  const { state } = p.c;
  const { store, apply } = p;
  const [place, setPlace] = createSignal<Place>(p.c.offer ? 'welcome' : 'questions');
  const [focus, setFocus] = createSignal<'card' | 'sidebar'>('card');
  const [cursor, setCursor] = createSignal(0);
  const [applyNotice, setApplyNotice] = createSignal<'noBack' | 'quitAgain' | null>(null);
  const [doctorKeys, setDoctorKeys] = createSignal<[string, string][]>([]);
  /** An install wrote telinha.env before "Back to questions". */
  const [appliedBefore, setAppliedBefore] = createSignal(false);
  createEffect(on(apply.stage, () => setApplyNotice(null), { defer: true }));

  let finished = false;
  const finish = (r: SetupUiResult) => {
    if (finished) return;
    finished = true;
    p.done(r);
  };

  const screen = () => (place() === 'questions' ? store.screen() : place());
  const cardActive = () => focus() === 'card';
  const asking = () => screen() === 'question' || screen() === 'review';

  const sideSteps = (): SidebarStep[] => {
    const steps = store.steps();
    const at = place();
    if (at === 'welcome') return steps.map((x) => ({ id: x.id, label: x.label, state: 'pending' }));
    if (at === 'apply' || at === 'doctor') {
      const ph = apply.stage();
      const install = ph === 'done' ? 'done' : ph === 'failed' ? 'failed' : 'running';
      return steps.map((x) => ({
        id: x.id,
        label: x.label,
        summary: x.summary,
        state: x.id === 'install' ? install : 'done',
      }));
    }
    return steps.map((x) => ({ id: x.id, label: x.label, summary: x.summary, state: x.state }));
  };

  // ---- the install
  const startApply = async (rotateCookie: boolean) => {
    apply.reset();
    setFocus('card');
    setPlace('apply');
    const hooks: ApplyHooks = {
      decide: (id, error) => apply.decide(id, error),
      withTerminal: p.withTerminal ?? ((fn) => fn()),
    };
    const r = await p.c.apply({ rotateCookie }, hooks);
    if (finished) return;
    if (r.kind === 'done') return apply.finish(r);
    if (r.kind === 'back') {
      // The file stays written whatever comes next: the Review must not say nothing changed.
      if (p.c.tasks.wroteAny) setAppliedBefore(true);
      return backTo(r.to);
    }
    finish({ kind: 'applied', result: r });
  };

  /** "Back to questions": the question the failed task is about (the setup state opens it by walking back from the Review). */
  const backTo = (id: TaskId) => {
    setPlace('questions');
    setFocus('card');
    const target = TASKS[id].backTo;
    if (state.screen() !== 'review' && !state.toReview()) return;
    if (target === 'review') return;
    for (let i = 0; i < 100; i++) {
      if (!state.back()) break;
      if (state.current().id === target) return;
    }
    // Not asked on this run (sysctl, UPnP): the Review.
    state.toReview();
  };

  const onCtrlC = () => {
    if (place() === 'apply' || place() === 'doctor') {
      const ph = apply.stage();
      if (ph === 'running') {
        // Stopping half way can leave a half install: ask for a second press.
        if (applyNotice() !== 'quitAgain') return void setApplyNotice('quitAgain');
        return finish({ kind: 'quit', reason: 'ctrl-c' });
      }
      if (ph === 'failed') {
        apply.choose('abort');
        return finish({ kind: 'quit', reason: 'ctrl-c' });
      }
      const r = apply.result();
      if (r) return finish({ kind: 'applied', result: r });
    }
    finish({ kind: 'quit', reason: 'ctrl-c' });
  };

  useKeys({
    key: (k) => {
      if (isCtrlC(k)) return onCtrlC(), true;
      if (k.ctrl || k.meta) return false;
      if (k.name === 'tab' && asking()) {
        if (focus() === 'card') {
          setCursor(
            Math.max(
              0,
              sideSteps().findIndex((x) => x.state === 'current'),
            ),
          );
          setFocus('sidebar');
        } else setFocus('card');
        return true;
      }
      if (k.name === 'escape' || k.name === 'left') {
        if (asking()) return state.back(), true;
        if (screen() === 'apply') return setApplyNotice('noBack'), true;
      }
      return false;
    },
  });

  const jump = (i: number) => {
    const step = sideSteps()[i];
    if (step && state.jump(step.id as StepId)) setFocus('card');
  };

  // ---- key help per state
  const footer = (): [string, string][] => {
    const quit: [string, string] = ['ctrl+c', t('keys.quit')];
    const move: [string, string] = ['↑↓', t('keys.move')];
    const select: [string, string] = ['enter', t('keys.select')];
    const back: [string, string] = ['esc/←', t('keys.back')];
    const steps: [string, string] = ['tab', t('keys.steps')];
    const sc = screen();
    if (focus() === 'sidebar' && asking()) return [move, ['enter', t('keys.jump')], ['esc', t('keys.question')], quit];
    if (sc === 'welcome') return [move, select, quit];
    if (sc === 'review') return [move, select, ['pgup/pgdn', t('keys.scroll')], back, steps, quit];
    if (sc === 'apply') return apply.stage() === 'running' ? [quit] : [move, select, quit];
    if (sc === 'doctor') return doctorKeys();
    const v = store.view();
    const kind = v && v.actions.length && (v.kind === 'text' || v.kind === 'secret') ? 'select' : v?.kind;
    if (kind === 'multi')
      return [move, ['space', t('keys.toggle')], ['a', t('keys.all')], ['enter', t('keys.confirm')], back, steps];
    if (kind === 'text') return [['enter', t('keys.confirm')], ['ctrl+u', t('keys.clear')], back, steps, quit];
    if (kind === 'secret')
      return [['ctrl+v', t('keys.paste')], ['enter', t('keys.confirm')], ['ctrl+r', t('keys.reveal')], back, steps];
    return [move, ['1-9', s('keys.pick')], select, back, steps, quit];
  };

  const sidebar = () => (
    <Sidebar
      steps={sideSteps()}
      focused={focus() === 'sidebar'}
      cursor={cursor()}
      maxRows={L.bodyRows()}
      onMove={setCursor}
      onJump={jump}
      onLeave={() => setFocus('card')}
    />
  );
  const result = () => apply.result();
  /** Esc / ←: running, nothing goes back; failed, "Back to questions" does; done, nothing to go back to. */
  const applyNoticeText = () => {
    const n = applyNotice();
    if (n === 'quitAgain') return t('common.quitAgain');
    if (n !== 'noBack') return null;
    const ph = apply.stage();
    return t(ph === 'running' ? 'common.noBack' : ph === 'failed' ? 'common.noBackFailed' : 'common.noBackDone');
  };

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Show when={!chrome.headerHidden()}>
        <Header mode="setup" version={p.c.version} />
      </Show>
      {/* Exactly the rows between header and footer: nothing taller can paint over the key help. */}
      <box
        flexDirection="row"
        height={L.bodyRows()}
        flexShrink={0}
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        alignItems="flex-start"
        overflow="hidden"
      >
        <Show when={L.sidebar()}>{sidebar()}</Show>
        <Show
          when={!L.sidebar() && focus() === 'sidebar'}
          fallback={
            <Switch>
              <Match when={screen() === 'welcome'}>
                <WelcomeScreen
                  envFile={p.c.offer?.envFile ?? p.c.shownFile}
                  active={cardActive}
                  onGo={() => setPlace('questions')}
                  onQuit={() => finish({ kind: 'declined' })}
                />
              </Match>
              <Match when={screen() === 'question'}>
                <QuestionScreen
                  state={state}
                  store={store}
                  active={cardActive}
                  quit={() => finish({ kind: 'quit', reason: 'review' })}
                />
              </Match>
              <Match when={screen() === 'review'}>
                <ReviewScreen
                  state={state}
                  store={store}
                  active={cardActive}
                  shownFile={p.c.shownFile}
                  docker={p.c.docker}
                  appliedBefore={appliedBefore()}
                  onApply={(rotate) => void startApply(rotate)}
                  onQuit={() => finish({ kind: 'quit', reason: 'review' })}
                />
              </Match>
              <Match when={screen() === 'apply'}>
                <ApplyScreen
                  store={apply}
                  badge={() => stepBadge(store, 'install', store.locale())}
                  docker={p.c.docker}
                  shownFile={p.c.shownFile}
                  webAddress={() => result()?.values.PUBLIC_URL ?? state.webAddress()}
                  canDoctor={!!p.c.doctor}
                  notice={applyNoticeText}
                  active={cardActive}
                  onDecide={(d) => void apply.choose(d)}
                  onDoctor={() => setPlace('doctor')}
                  onExit={() => finish({ kind: 'applied', result: result()! })}
                />
              </Match>
              <Match when={screen() === 'doctor' && p.c.doctor}>
                {(doctor: Accessor<NonNullable<SetupUiContext['doctor']>>) => (
                  <DoctorScreen
                    embedded
                    locale={store.locale()}
                    version={p.c.version}
                    checks={p.checks ?? CHECKS}
                    buildContext={() => doctor().buildContext()}
                    initial={result()?.doctor ?? undefined}
                    phone={
                      result()?.tasks.start === 'ok'
                        ? { control: doctor().control, env: p.c.ctx.env, config: doctor().config() }
                        : null
                    }
                    onFooter={setDoctorKeys}
                    onExit={() => setPlace('apply')}
                  />
                )}
              </Match>
            </Switch>
          }
        >
          {sidebar()}
        </Show>
      </box>
      <Footer items={footer()} />
    </box>
  );
}
