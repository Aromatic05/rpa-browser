import crypto from 'node:crypto';
import { dispatch, runStep } from './e2e_multitab_helper';
import type { Action } from '../../src/interface/actions/action_protocol';
import type { StepUnion } from '../../src/automation/runner/steps/types';

const st = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> =>
    ({ id, name, args } as unknown as Extract<StepUnion, { name: T }>);

const actWs = (type: string, workspaceName: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName,
    payload,
    at: Date.now(),
});

export type PanelSessionSnapshot = {
    sessionId: string;
    state: string;
    reportAvailable: string;
    selected: boolean;
    text: string;
};

export type PanelSnapshot = {
    ok: boolean;
    sessions: PanelSessionSnapshot[];
    reports: string[];
    errors: string[];
    loading: string[];
    startDisabled: boolean | null;
    panelCount: number;
    text: string;
};

type PanelEvalResult = {
    ok: boolean;
    reason?: string;
    label?: string;
    sessionId?: string;
    text?: string;
    panelCount?: number;
    hasAgentTab?: boolean;
    sessions?: PanelSessionSnapshot[];
    reports?: string[];
    errors?: string[];
    loading?: string[];
    startDisabled?: boolean | null;
};

const PANEL_JS = `
  const body = shadow.querySelector('.body');
  if (!body) return { ok:false, reason:'no-body' };
  const panelBox = shadow.querySelector('.panel');
  if (panelBox && !panelBox.classList.contains('open')) {
    const ball = shadow.querySelector('.ball');
    if (ball) ball.click();
  }
  const agentTab = [...shadow.querySelectorAll('.tabs button')].find((b) => (b.textContent || '').trim() === 'Agent');
  if (agentTab && agentTab.classList && !agentTab.classList.contains('active')) agentTab.click();
  const setValue = (el, value, evt) => { el.value = value; el.dispatchEvent(new Event(evt || 'input', { bubbles:true })); };
  const buttonIn = (root, label) => [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label);
  const findSession = (id) => [...body.querySelectorAll('.log-item')].find((el) => el.dataset.sessionId === id);
  switch (op) {
    case 'panel': {
      return { ok:true, panelCount: document.querySelectorAll('#rpa-floating-panel').length, hasAgentTab: Boolean(agentTab) };
    }
    case 'set-inputs': {
      const ta = body.querySelector('textarea');
      if (ta && typeof args.prompt === 'string') setValue(ta, args.prompt, 'input');
      const provider = [...body.querySelectorAll('input')].find((i) => i.placeholder === 'provider');
      const model = [...body.querySelectorAll('input')].find((i) => i.placeholder === 'model');
      if (provider && typeof args.provider === 'string') setValue(provider, args.provider, 'input');
      if (model && typeof args.model === 'string') setValue(model, args.model, 'input');
      const select = body.querySelector('select');
      if (select && typeof args.mode === 'string') setValue(select, args.mode, 'change');
      return { ok:true };
    }
    case 'click': {
      const btn = buttonIn(body, args.label);
      if (!btn) return { ok:false, reason:'no-button', label: String(args.label), text: body.textContent || '' };
      btn.click();
      return { ok:true };
    }
    case 'click-session': {
      const item = findSession(args.sessionId);
      if (!item) return { ok:false, reason:'no-session', sessionId: String(args.sessionId), text: body.textContent || '' };
      const btn = buttonIn(item, args.label);
      if (!btn) return { ok:false, reason:'no-session-button', label: String(args.label), sessionId: String(args.sessionId) };
      btn.click();
      return { ok:true };
    }
    case 'select-session': {
      const item = findSession(args.sessionId);
      if (!item) return { ok:false, reason:'no-session', sessionId: String(args.sessionId), text: body.textContent || '' };
      const head = item.querySelector('.selectable');
      if (!head) return { ok:false, reason:'no-selectable', sessionId: String(args.sessionId) };
      head.click();
      return { ok:true };
    }
    case 'snapshot': {
      const sessions = [...body.querySelectorAll('.log-item')]
        .filter((el) => el.dataset.sessionId)
        .map((el) => ({
          sessionId: el.dataset.sessionId || '',
          state: el.dataset.sessionState || '',
          reportAvailable: el.dataset.reportAvailable || 'false',
          selected: el.dataset.selected === 'true',
          text: (el.textContent || '').trim(),
        }));
      const reports = [...body.querySelectorAll('.section')]
        .filter((section) => {
          const title = section.querySelector('.title');
          return title && (title.textContent || '').startsWith('Report — ');
        })
        .map((section) => (section.textContent || '').trim());
      const errors = [...body.querySelectorAll('[data-status-hint="error"]')].map((el) => el.textContent || '');
      const loading = [...body.querySelectorAll('[data-status-hint]')].map((el) => el.getAttribute('data-status-hint') || '');
      let startDisabled = null;
      const startBtn = buttonIn(body, 'Start');
      if (startBtn) startDisabled = startBtn.disabled;
      if (startDisabled === null) {
        const starting = buttonIn(body, 'Starting…');
        if (starting) startDisabled = true;
      }
      return { ok:true, sessions, reports, errors, loading, startDisabled, panelCount: document.querySelectorAll('#rpa-floating-panel').length, text: body.textContent || '' };
    }
    default:
      return { ok:false, reason:'unknown-op' };
  }
`;

export const panelEval = async (
    endpoint: string,
    workspaceName: string,
    op: string,
    args: Record<string, unknown> = {},
): Promise<PanelEvalResult & Partial<PanelSnapshot>> => {
    const expression = [
        'return (() => {',
        `const op = ${JSON.stringify(op)};`,
        `const args = ${JSON.stringify(args)};`,
        "const panel = document.getElementById('rpa-floating-panel');",
        "if (!panel || !panel.shadowRoot) return { ok:false, reason:'no-panel' };",
        'const shadow = panel.shadowRoot;',
        PANEL_JS,
        '})();',
    ].join('\n');
    const result = await runStep(endpoint, workspaceName, st(`agent-panel-${op}`, 'browser.evaluate', {expression}));
    if (!result.ok) {
        throw new Error(`panel eval ${op} failed: ${JSON.stringify(result.error || {})}`);
    }
    return result.data as PanelEvalResult & Partial<PanelSnapshot>;
};

/**
 * Opens a new tab in the real extension-mode browser at `url`, switches the
 * active workspace tab to it, and waits until the injected floating UI is live.
 */
export const openPanelTab = async (
    endpoint: string,
    workspaceName: string,
    url: string,
    timeoutMs = 30_000,
): Promise<string> => {
    const before = await dispatch(endpoint, actWs('tab.list', workspaceName));
    if (before.type !== 'tab.list.result') {
        throw new Error(`tab.list failed: ${before.type}`);
    }
    const beforeNames = ((before.payload ?? {}) as {tabs?: Array<{tabName: string}>}).tabs?.map((tab) => tab.tabName) ?? [];

    const opened = await dispatch(endpoint, actWs('tab.open', workspaceName, {startUrl: url, source: 'e2e.agent'}));
    if (opened.type !== 'tab.open.result') {
        throw new Error(`tab.open failed (${opened.type}): ${JSON.stringify(opened.payload ?? {})}`);
    }

    let tabName = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const listed = await dispatch(endpoint, actWs('tab.list', workspaceName));
        const tabs = ((listed.payload ?? {}) as {tabs?: Array<{tabName: string}>}).tabs ?? [];
        const created = tabs.find((tab) => !beforeNames.includes(tab.tabName));
        if (created?.tabName) {
            tabName = created.tabName;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!tabName) {
        throw new Error('opened agent panel tab was not discovered in tab.list');
    }

    const switched = await runStep(endpoint, workspaceName, st('agent-panel-switch', 'browser.switch_tab', {tabName}));
    if (!switched.ok) {
        throw new Error(`browser.switch_tab failed: ${JSON.stringify(switched.error || {})}`);
    }
    const navigated = await runStep(endpoint, workspaceName, st('agent-panel-goto', 'browser.goto', {url}));
    if (!navigated.ok) {
        throw new Error(`browser.goto failed: ${JSON.stringify(navigated.error || {})}`);
    }
    return tabName;
};

/**
 * Waits until the floating UI panel is present and reachable in the bound tab.
 */
export const waitForPanel = async (
    endpoint: string,
    workspaceName: string,
    timeoutMs = 30_000,
): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let last: PanelEvalResult & Partial<PanelSnapshot> | null = null;
    while (Date.now() < deadline) {
        last = await panelEval(endpoint, workspaceName, 'panel', {});
        if (last.ok && (last.panelCount ?? 0) === 1) {return;}
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`floating UI panel did not appear: ${JSON.stringify(last)}`);
};