import { test, expect } from '@playwright/test';
import { createE2EStepActionHarness } from '../../helpers/e2e_step_action_helper';
import type { StepUnion } from '../../../src/runner/steps/types';

const makeStep = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> => ({
    id,
    name,
    args,
});

test('E2E-1 step actions should work via agent + extension + workspace on real fixture page', async () => {
    const harness = await createE2EStepActionHarness();
    try {
        const gotoResult = await harness.runStep(makeStep('s1-goto', 'browser.goto', { url: harness.fixtureUrl }));
        expect(gotoResult.ok).toBeTruthy();

        const fillResult = await harness.runStep(makeStep('s2-fill', 'browser.fill', { selector: '[data-testid="customer-name"]', value: '上海智算科技' }));
        expect(fillResult.ok).toBeTruthy();
        const fillState = await harness.runStep(makeStep('s2-check', 'browser.evaluate', { expression: 'return {v: document.querySelector("[data-testid=live-status]")?.dataset.customerName, text: document.querySelector("[data-testid=live-status]")?.textContent};' }));
        expect(fillState.ok).toBeTruthy();
        expect((fillState.data as any).v).toBe('上海智算科技');
        expect(String((fillState.data as any).text)).toContain('客户名(上海智算科技)');

        const typeResult = await harness.runStep(makeStep('s3-type', 'browser.type', { selector: '[data-testid="notes"]', text: '首访客户，已完成需求初访。' }));
        expect(typeResult.ok).toBeTruthy();
        const typeState = await harness.runStep(makeStep('s3-check', 'browser.evaluate', { expression: 'const el = document.querySelector("[data-testid=notes]"); return el ? el.value : "";' }));
        expect(typeState.ok).toBeTruthy();
        expect(String(typeState.data)).toContain('首访客户');

        const selectResult = await harness.runStep(makeStep('s4-select', 'browser.select_option', { selector: '#customerLevel', kind: 'native_select', values: ['gold'] }));
        if (!selectResult.ok) {
            throw new Error(`select_option failed: ${JSON.stringify(selectResult.error)}`);
        }
        const selectState = await harness.runStep(makeStep('s4-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.level;' }));
        expect(selectState.ok).toBeTruthy();
        expect(selectState.data).toBe('gold');

        const checkboxResult = await harness.runStep(makeStep('s5-checkbox', 'browser.click', { selector: '[data-testid="mail-notify"]' }));
        expect(checkboxResult.ok).toBeTruthy();
        const checkboxState = await harness.runStep(makeStep('s5-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.mailNotify;' }));
        expect(checkboxState.ok).toBeTruthy();
        expect(checkboxState.data).toBe('true');

        const radioResult = await harness.runStep(makeStep('s6-radio', 'browser.click', { selector: '[data-testid="status-paused"]' }));
        expect(radioResult.ok).toBeTruthy();
        const radioState = await harness.runStep(makeStep('s6-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.status;' }));
        expect(radioState.ok).toBeTruthy();
        expect(radioState.data).toBe('paused');

        await harness.runStep(makeStep('s7-focus-search', 'browser.click', { selector: '[data-testid="search-box"]' }));
        const pressResult = await harness.runStep(makeStep('s7-press', 'browser.press_key', { selector: '[data-testid="search-box"]', key: 'Enter' }));
        expect(pressResult.ok).toBeTruthy();
        const pressState = await harness.runStep(makeStep('s7-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.lastKey;' }));
        expect(pressState.ok).toBeTruthy();
        expect(pressState.data).toBe('Enter');

        const hoverResult = await harness.runStep(makeStep('s8-hover', 'browser.hover', { selector: '[data-testid="help-zone"]' }));
        expect(hoverResult.ok).toBeTruthy();
        const hoverState = await harness.runStep(makeStep('s8-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.helpVisible;' }));
        expect(hoverState.ok).toBeTruthy();
        expect(hoverState.data).toBe('true');

        const scrollResult = await harness.runStep(makeStep('s9-scroll', 'browser.scroll', { selector: '#logContainer', direction: 'down', amount: 600 }));
        expect(scrollResult.ok).toBeTruthy();
        const scrollState = await harness.runStep(makeStep('s9-check', 'browser.evaluate', { expression: 'return Number(document.querySelector("[data-testid=live-status]")?.dataset.scrollTop || 0);' }));
        expect(scrollState.ok).toBeTruthy();
        expect(Number(scrollState.data)).toBeGreaterThan(0);

        const saveResult = await harness.runStep(makeStep('s10-save', 'browser.click', { selector: '[data-testid="save-btn"]' }));
        expect(saveResult.ok).toBeTruthy();
        const saveState = await harness.runStep(makeStep('s10-check', 'browser.evaluate', {
            expression: 'const zone=document.querySelector("[data-testid=result-zone]"); return {saved: zone?.dataset.saved, summary: zone?.dataset.summary, text: zone?.textContent};',
        }));
        expect(saveState.ok).toBeTruthy();
        expect((saveState.data as any).saved).toBe('true');
        expect(String((saveState.data as any).summary)).toContain('name=上海智算科技');
        expect(String((saveState.data as any).summary)).toContain('level=gold');
        expect(String((saveState.data as any).summary)).toContain('mail=true');
        expect(String((saveState.data as any).summary)).toContain('status=paused');
        expect(String((saveState.data as any).summary)).toContain('notes=首访客户');

        const snapshotResult = await harness.runStep(makeStep('s11-snapshot', 'browser.snapshot', {}));
        expect(snapshotResult.ok).toBeTruthy();
        expect(snapshotResult.data).toBeTruthy();
        expect((snapshotResult.data as any).id).toBeTruthy();
        expect(Array.isArray((snapshotResult.data as any).children)).toBeTruthy();

        const screenshotResult = await harness.runStep(makeStep('s12-screenshot', 'browser.take_screenshot', { inline: true }));
        expect(screenshotResult.ok).toBeTruthy();
        expect((screenshotResult.data as any)?.mime).toBe('image/png');
        expect(typeof (screenshotResult.data as any)?.base64).toBe('string');
        expect((screenshotResult.data as any)?.base64.length).toBeGreaterThan(100);

        const notFoundResult = await harness.runStep(makeStep('s13-not-found', 'browser.click', { selector: '#not-exist-selector-e2e' }));
        expect(notFoundResult.ok).toBeFalsy();
        expect(notFoundResult.error).toBeTruthy();
        expect(notFoundResult.error?.code).toBeTruthy();
    } finally {
        await harness.close();
    }
});

test.setTimeout(120000);
