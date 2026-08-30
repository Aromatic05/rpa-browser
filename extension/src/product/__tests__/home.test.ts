import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyText, idleView, mount, openPanel, runningView, type MountResult } from './harness.js';

const typeComposer = (fixture: MountResult, value: string): void => {
    const textarea = fixture.shadow.querySelector('[data-rpa-product-composer]') as HTMLTextAreaElement;
    textarea.value = value;
    textarea.dispatchEvent(new fixture.dom.window.Event('input', { bubbles: true }));
};

test('Home composer emits only a typed startTask intent with the trimmed prompt', () => {
    const fixture = mount(idleView());
    try {
        openPanel(fixture);
        const start = fixture.shadow.querySelector('[data-rpa-product-action="start"]') as HTMLButtonElement;
        assert.equal(start.disabled, true, 'Start disabled while the prompt is empty');
        assert.match(bodyText(fixture), /Describe the task first\./);

        typeComposer(fixture, '  Fill the order form  ');
        assert.equal(start.disabled, false);
        start.click();

        const startCall = fixture.calls.find((call) => call.name === 'startTask');
        assert.ok(startCall, 'startTask intent emitted');
        assert.deepEqual(startCall.args, ['Fill the order form']);
    } finally {
        fixture.cleanup();
    }
});

test('Enter in the composer starts the task', () => {
    const fixture = mount(idleView());
    try {
        openPanel(fixture);
        const textarea = fixture.shadow.querySelector('[data-rpa-product-composer]') as HTMLTextAreaElement;
        typeComposer(fixture, 'Summarize this page');
        textarea.dispatchEvent(
            new fixture.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
        assert.equal(fixture.calls.some((call) => call.name === 'startTask'), true);
    } finally {
        fixture.cleanup();
    }
});

test('Teach and Annotate are first-class entry cards from Home', () => {
    const fixture = mount(idleView());
    try {
        openPanel(fixture);
        assert.match(bodyText(fixture), /Teach a workflow/);
        assert.match(bodyText(fixture), /Annotate this page/);

        const teach = fixture.shadow.querySelector('[data-rpa-product-action="teach"]') as HTMLButtonElement;
        teach.click();
        assert.equal(fixture.calls.some((call) => call.name === 'openTeach'), true);
        assert.equal(fixture.body.dataset.rpaProductSurface, 'teach', 'Teach setup is a product surface');
        assert.match(bodyText(fixture), /Reusable business procedure/);
        assert.match(bodyText(fixture), /Basic demonstration/);
    } finally {
        fixture.cleanup();
    }
});

test('no provider/model/session/execution-mode terms appear in the default product UI', () => {
    const fixture = mount(idleView());
    try {
        openPanel(fixture);
        const text = bodyText(fixture).toLowerCase();
        for (const term of ['provider', 'executionmode', 'sessionid', 'runid', 'continuationid', 'recompute', 'abort', 'revision']) {
            assert.equal(text.includes(term), false, `internal term must not render: ${term}`);
        }
        fixture.handle.setView(runningView());
        const runningText = bodyText(fixture).toLowerCase();
        for (const term of ['provider', 'executionmode', 'sessionid', 'runid', 'continuationid']) {
            assert.equal(runningText.includes(term), false, `internal term must not render while running: ${term}`);
        }
    } finally {
        fixture.cleanup();
    }
});

test('active workspace activity disables conflicting authoring and shows the guard', () => {
    const fixture = mount(runningView());
    try {
        openPanel(fixture);
        (fixture.shadow.querySelector('[data-rpa-product-nav="home"]') as HTMLButtonElement).click();
        const guard = fixture.shadow.querySelector('[data-rpa-product-guard]');
        assert.ok(guard, 'activity guard is shown');
        assert.match(bodyText(fixture), /This workspace is already in use\./);
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-composer]'), null, 'no composer while busy');
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-action="start"]'), null, 'no Start while busy');
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-action="teach"]'), null, 'no Teach while busy');
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-action="annotate"]'), null, 'no Annotate while busy');

        const openCurrent = fixture.shadow.querySelector('[data-rpa-product-action="open-current"]') as HTMLButtonElement;
        openCurrent.click();
        assert.equal(fixture.calls.some((call) => call.name === 'openCurrentActivity'), true);
    } finally {
        fixture.cleanup();
    }
});

test('Teach setup distinguishes Structured Teach from Basic Demonstration', () => {
    const fixture = mount(idleView());
    try {
        openPanel(fixture);
        (fixture.shadow.querySelector('[data-rpa-product-action="teach"]') as HTMLButtonElement).click();
        const text = bodyText(fixture);
        assert.match(text, /Reusable business procedure/);
        assert.match(text, /Basic demonstration/);
        assert.match(text, /Structured teaching saves a reusable Procedure or Recovery/);

        const recovery = fixture.shadow.querySelector('input[data-rpa-product-field="teach-kind"][value="recovery"]') as HTMLInputElement;
        recovery.checked = true;
        recovery.dispatchEvent(new fixture.dom.window.Event('change', { bubbles: true }));
        assert.match(bodyText(fixture), /Structured teaching saves a reusable Procedure or Recovery/);

        const demonstration = fixture.shadow.querySelector('input[data-rpa-product-field="teach-kind"][value="demonstration"]') as HTMLInputElement;
        demonstration.checked = true;
        demonstration.dispatchEvent(new fixture.dom.window.Event('change', { bubbles: true }));
        assert.match(bodyText(fixture), /Basic demonstration is the secondary path/);
        assert.equal(
            fixture.shadow.querySelector('[data-rpa-product-field="business-area"]'),
            null,
            'no business area for a basic demonstration',
        );

        (fixture.shadow.querySelector('[data-rpa-product-action="start-teach"]') as HTMLButtonElement).click();
        const startTeach = fixture.calls.find((call) => call.name === 'startTeach');
        assert.ok(startTeach);
        assert.deepEqual(startTeach.args, ['demonstration', undefined]);
    } finally {
        fixture.cleanup();
    }
});