import {expect, test} from '@playwright/test';
import {dispatch, runStep, startAgent} from '../../helpers/e2e_multitab_helper';
import {startFixtureServer} from '../../helpers/server';
import type {StepUnion} from '../../../src/runner/steps/types';

const step = (id: string, expression: string): StepUnion => ({
    id,
    name: 'browser.evaluate',
    args: {expression},
} as StepUnion);

let endpoint = '';
let fixtureUrl = '';
let closeAgent: () => Promise<void> = async () => undefined;
let closeFixture: () => Promise<void> = async () => undefined;

test.beforeEach(async () => {
    const fixture = await startFixtureServer();
    fixtureUrl = `${fixture.baseURL}/entity_rules/annotator_form.html`;
    closeFixture = fixture.close;
    const agent = await startAgent();
    endpoint = agent.endpoint;
    closeAgent = agent.close;
});

test.afterEach(async () => {
    await closeAgent();
    await closeFixture();
});

test('Rules panel materializes and saves canonical annotations through the extension', async () => {
    const workspaceName = 'default';
    const before = await dispatch(endpoint, {
        v: 1,
        id: crypto.randomUUID(),
        type: 'tab.list',
        workspaceName,
        payload: {},
        at: Date.now(),
    });
    const knownTabs = new Set((((before.payload ?? {}) as {tabs?: Array<{tabName: string}>}).tabs ?? [])
        .map((tab) => tab.tabName));
    const opened = await dispatch(endpoint, {
        v: 1,
        id: crypto.randomUUID(),
        type: 'tab.open',
        workspaceName,
        payload: {startUrl: fixtureUrl, source: 'e2e.annotator-panel'},
        at: Date.now(),
    });
    expect(opened.type).toBe('tab.open.result');

    let tabName = '';
    await expect.poll(async () => {
        const listed = await dispatch(endpoint, {
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.list',
            workspaceName,
            payload: {},
            at: Date.now(),
        });
        const created = (((listed.payload ?? {}) as {tabs?: Array<{tabName: string}>}).tabs ?? [])
            .find((tab) => !knownTabs.has(tab.tabName));
        tabName = created?.tabName ?? '';
        return tabName;
    }, {timeout: 15_000}).toBeTruthy();

    expect((await runStep(endpoint, workspaceName, {
        id: 'switch-annotator-tab',
        name: 'browser.switch_tab',
        args: {tabName},
    } as StepUnion)).ok).toBeTruthy();
    expect((await runStep(endpoint, workspaceName, {
        id: 'goto-annotator-fixture',
        name: 'browser.goto',
        args: {url: fixtureUrl},
    } as StepUnion)).ok).toBeTruthy();

    await expect.poll(async () => {
        const result = await runStep(endpoint, workspaceName, step(
            'panel-host-ready',
            'return Boolean(document.getElementById("rpa-floating-panel")?.shadowRoot);',
        ));
        return result.ok && result.data === true;
    }, {timeout: 15_000}).toBeTruthy();

    const openedPanel = await runStep(endpoint, workspaceName, step('open-rules-panel', `
      const host = document.getElementById('rpa-floating-panel');
      const root = host?.shadowRoot;
      if (!root) return false;
      root.querySelector('.ball')?.click();
      const rules = Array.from(root.querySelectorAll('.tabs button')).find((button) => button.textContent === 'Rules');
      rules?.click();
      return Boolean(root.querySelector('[data-rpa-annotator-panel]'));
    `));
    expect(openedPanel.ok).toBeTruthy();
    expect(openedPanel.data).toBe(true);

    const inspected = await runStep(endpoint, workspaceName, step('inspect-rules-page', `
      const root = document.getElementById('rpa-floating-panel')?.shadowRoot;
      const panel = root?.querySelector('[data-rpa-annotator-panel]');
      if (!panel) return false;
      const profile = panel.querySelector('[data-annotator-profile]');
      const pageKind = panel.querySelector('[data-annotator-page-kind]');
      const urlPattern = panel.querySelector('[data-annotator-url-pattern]');
      if (!(profile instanceof HTMLInputElement) || !(pageKind instanceof HTMLSelectElement)
          || !(urlPattern instanceof HTMLInputElement)) return false;
      profile.value = 'e2e-customer-form';
      pageKind.value = 'form';
      urlPattern.value = '/entity_rules/annotator_form.html';
      const inspect = Array.from(panel.querySelectorAll('button')).find((button) => button.textContent === 'Inspect page');
      inspect?.click();
      return true;
    `));
    expect(inspected.ok).toBeTruthy();
    expect(inspected.data).toBe(true);

    await expect.poll(async () => {
        const result = await runStep(endpoint, workspaceName, step('wait-rules-targets', `
          const panel = document.getElementById('rpa-floating-panel')?.shadowRoot
            ?.querySelector('[data-rpa-annotator-panel]');
          const target = panel?.querySelector('[data-annotator-target]');
          return target instanceof HTMLSelectElement ? Array.from(target.options).map((option) => option.textContent) : [];
        `));
        const labels = result.ok && Array.isArray(result.data) ? result.data.map(String) : [];
        return labels.some((label) => label.startsWith('structural-root/form:'))
            && labels.includes('field/form: Customer name')
            && labels.includes('action/form: Save customer');
    }, {timeout: 20_000}).toBe(true);

    const apply = async (id: string, targetNeedle: string, semanticValue: string) => {
        const result = await runStep(endpoint, workspaceName, step(id, `
          const panel = document.getElementById('rpa-floating-panel')?.shadowRoot
            ?.querySelector('[data-rpa-annotator-panel]');
          if (!panel) return false;
          const target = panel.querySelector('[data-annotator-target]');
          const value = panel.querySelector('[data-annotator-semantic-value]');
          if (!(target instanceof HTMLSelectElement) || !(value instanceof HTMLInputElement)) return false;
          const option = Array.from(target.options).find((candidate) => candidate.textContent?.includes(${JSON.stringify(targetNeedle)}));
          if (!option) return false;
          target.value = option.value;
          target.dispatchEvent(new Event('change', {bubbles: true}));
          value.value = ${JSON.stringify(semanticValue)};
          value.dispatchEvent(new Event('input', {bubbles: true}));
          const applyButton = Array.from(panel.querySelectorAll('button')).find((button) => button.textContent === 'Apply annotation');
          applyButton?.click();
          return true;
        `));
        expect(result.ok).toBeTruthy();
        expect(result.data).toBe(true);
        await expect.poll(async () => {
            const checked = await runStep(endpoint, workspaceName, step(`${id}-wait`, `
              const panel = document.getElementById('rpa-floating-panel')?.shadowRoot
                ?.querySelector('[data-rpa-annotator-panel]');
              return panel?.querySelector('[data-annotator-bindings]')?.textContent || '';
            `));
            return String(checked.data ?? '');
        }, {timeout: 20_000}).toContain(semanticValue);
    };

    await apply('apply-form-entity', 'structural-root/form', 'customer.form');
    await apply('apply-customer-field', 'field/form: Customer name', 'customerName');

    const saved = await runStep(endpoint, workspaceName, step('save-rules-profile', `
      const panel = document.getElementById('rpa-floating-panel')?.shadowRoot
        ?.querySelector('[data-rpa-annotator-panel]');
      const save = panel ? Array.from(panel.querySelectorAll('button')).find((button) => button.textContent === 'Save') : undefined;
      save?.click();
      return Boolean(save);
    `));
    expect(saved.ok).toBeTruthy();
    expect(saved.data).toBe(true);

    await expect.poll(async () => {
        const reply = await dispatch(endpoint, {
            v: 1,
            id: crypto.randomUUID(),
            type: 'entity_rules.get',
            workspaceName,
            payload: {profileName: 'e2e-customer-form'},
            at: Date.now(),
        });
        if (reply.type !== 'entity_rules.get.result') return null;
        return (reply.payload as {profile?: unknown})?.profile ?? null;
    }, {timeout: 20_000}).toMatchObject({
        kind: 'entity_rules',
        name: 'e2e-customer-form',
        page: {kind: 'form', urlPattern: '/entity_rules/annotator_form.html'},
        annotation: {
            version: 2,
            bindings: expect.arrayContaining([
                expect.objectContaining({businessTag: 'customer.form'}),
                expect.objectContaining({fieldKey: 'customerName'}),
            ]),
        },
    });
});

test.setTimeout(120_000);
