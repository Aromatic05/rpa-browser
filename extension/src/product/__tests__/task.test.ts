import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bodyText,
    keydown,
    mount,
    openPanel,
    runningTask,
    runningView,
    waitingView,
    typeInto,
} from './harness.js';
import type { AgentTaskView, InteractionRequest } from '../model/contracts.js';

test('running without an emitted phase shows exactly Running', () => {
    const fixture = mount(runningView({ phase: undefined }));
    try {
        openPanel(fixture);
        const header = fixture.shadow.querySelector('[data-rpa-product-block="task-header"]') as HTMLElement;
        assert.ok(header, 'task header rendered');
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- textContent is nullish per lib.dom
        const headerText = header.textContent ?? '';
        assert.match(headerText, /Running/);
        for (const phase of ['Planning', 'Observing', 'Executing', 'Recovering']) {
            assert.equal(headerText.includes(phase), false, `phase must not render: ${phase}`);
        }
    } finally {
        fixture.cleanup();
    }
});

test('running with a backend-emitted phase shows the phase truthfully', () => {
    const fixture = mount(runningView({ phase: 'observing' }));
    try {
        openPanel(fixture);
        const headerText = fixture.shadow.querySelector('[data-rpa-product-block="task-header"]')?.textContent ?? '';
        assert.match(headerText, /Running · Observing/);
        assert.equal(headerText.includes('Planning'), false);
    } finally {
        fixture.cleanup();
    }
});

test('the sanitized timeline renders observable activity and nothing internal', () => {
    const task: AgentTaskView = {
        ...runningTask({
            timeline: [
                { kind: 'task_created', summary: 'Task started', at: 1000 },
                { kind: 'phase_changed', phase: 'executing', at: 1500 },
                { kind: 'effect_applied', summary: 'Filled field "Delivery address"', status: 'ok', at: 2000 },
                { kind: 'world_conflict', summary: 'Expected order id differs from actual', at: 2500 },
            ],
        }),
    };
    const fixture = mount(runningView(task));
    try {
        openPanel(fixture);
        const timeline = fixture.shadow.querySelector('.rpa-timeline') as HTMLElement;
        assert.ok(timeline);
        assert.equal(timeline.getAttribute('role'), 'list');
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- textContent is nullish per lib.dom
        const text = timeline.textContent ?? '';
        assert.match(text, /Task started/);
        assert.match(text, /Now Executing/);
        assert.match(text, /Applied: Filled field "Delivery address"/);
        assert.match(text, /Conflict: Expected order id differs from actual/);
    } finally {
        fixture.cleanup();
    }
});

test('two-step Stop: Stop arms, Confirm stop emits stopTask, Escape disarms', () => {
    const fixture = mount(runningView());
    try {
        openPanel(fixture);
        const stop = fixture.shadow.querySelector('[data-rpa-product-action="stop"]') as HTMLButtonElement;
        assert.ok(stop);
        stop.click();
        assert.equal(fixture.calls.some((call) => call.name === 'stopTask'), false, 'no stop before confirm');
        assert.ok(
            fixture.shadow.querySelector('[data-rpa-product-action="confirm-stop"]'),
            'button re-labels to Confirm stop',
        );

        keydown(fixture, 'Escape');
        assert.ok(
            fixture.shadow.querySelector('[data-rpa-product-action="stop"]'),
            'Escape disarms the two-step stop',
        );
        assert.equal(fixture.calls.some((call) => call.name === 'stopTask'), false);

        (fixture.shadow.querySelector('[data-rpa-product-action="stop"]') as HTMLButtonElement).click();
        (fixture.shadow.querySelector('[data-rpa-product-action="confirm-stop"]') as HTMLButtonElement).click();
        assert.equal(fixture.calls.some((call) => call.name === 'stopTask'), true);
    } finally {
        fixture.cleanup();
    }
});

test('waiting_for_user without an interaction shows Preparing with no CTAs', () => {
    const task: AgentTaskView = runningTask({ status: 'waiting_for_user', interaction: undefined });
    const fixture = mount(runningView(task));
    try {
        openPanel(fixture);
        assert.match(bodyText(fixture), /Preparing…/);
        assert.equal(fixture.shadow.querySelector('[data-rpa-product-card]'), null, 'no card while preparing');
    } finally {
        fixture.cleanup();
    }
});

test('approval card approves directly and requires a reason to deny', () => {
    const interaction: InteractionRequest = {
        kind: 'approval',
        interactionToken: 'tok-1',
        effectName: 'Publish order to ERP',
        risk: 'This action cannot be undone. It was prepared from the current page state.',
        evidence: 'expected vendor + line items',
    };
    const fixture = mount(waitingView(interaction));
    try {
        openPanel(fixture);
        const text = bodyText(fixture);
        assert.match(text, /Approval needed/);
        assert.match(text, /Publish order to ERP/);

        (fixture.shadow.querySelector('[data-rpa-product-action="approve"]') as HTMLButtonElement).click();
        assert.equal(fixture.calls.some((call) => call.name === 'approve'), true);

        (fixture.shadow.querySelector('[data-rpa-product-action="deny"]') as HTMLButtonElement).click();
        typeInto(fixture, 'deny-reason', '   ');
        (fixture.shadow.querySelector('[data-rpa-product-action="submit-denial"]') as HTMLButtonElement).click();
        assert.equal(fixture.calls.some((call) => call.name === 'deny'), false, 'empty reason must not emit deny');
        assert.match(bodyText(fixture), /Reason is required\./);

        typeInto(fixture, 'deny-reason', 'The vendor is wrong');
        typeInto(fixture, 'deny-alternative', 'Use the secondary vendor');
        (fixture.shadow.querySelector('[data-rpa-product-action="submit-denial"]') as HTMLButtonElement).click();
        const denyCall = fixture.calls.find((call) => call.name === 'deny');
        assert.ok(denyCall);
        assert.deepEqual(denyCall.args, ['The vendor is wrong', 'Use the secondary vendor']);
    } finally {
        fixture.cleanup();
    }
});

test('clarification validates against the schema before emitting an answer', () => {
    const interaction: InteractionRequest = {
        kind: 'clarification',
        interactionToken: 'tok-2',
        question: 'Which delivery date should we target?',
        schema: { field: 'deliveryDate', type: 'text', maxLength: 8 },
    };
    const fixture = mount(waitingView(interaction));
    try {
        openPanel(fixture);
        assert.match(bodyText(fixture), /Which delivery date should we target\?/);

        typeInto(fixture, 'clarification', '2026-09-30');
        (fixture.shadow.querySelector('[data-rpa-product-action="submit-answer"]') as HTMLButtonElement).click();
        assert.match(bodyText(fixture), /Must be at most 8 characters\./);
        assert.equal(fixture.calls.some((call) => call.name === 'answerClarification'), false);

        typeInto(fixture, 'clarification', 'Sep 30');
        (fixture.shadow.querySelector('[data-rpa-product-action="submit-answer"]') as HTMLButtonElement).click();
        const answerCall = fixture.calls.find((call) => call.name === 'answerClarification');
        assert.ok(answerCall);
        assert.deepEqual(answerCall.args, ['Sep 30']);
    } finally {
        fixture.cleanup();
    }
});

test('recovery card renders only backend options with block reasons and terminate label', () => {
    const interaction: InteractionRequest = {
        kind: 'recovery_decision',
        interactionToken: 'tok-3',
        failureSummary: '"Confirm order" could not be verified.',
        evidence: 'expected order id differs from actual',
        options: [
            { id: 'retry-1', kind: 'retry', label: 'Retry', eligible: true },
            { id: 'rollback-1', kind: 'rollback', label: 'Rollback', eligible: false, block: 'irreversible effects' },
            { id: 'end-1', kind: 'terminate', label: 'End task as failed', eligible: true },
        ],
        recommendedOptionId: 'retry-1',
    };
    const fixture = mount(waitingView(interaction));
    try {
        openPanel(fixture);
        const text = bodyText(fixture);
        assert.match(text, /Recovery decision/);
        assert.match(text, /"Confirm order" could not be verified\./);
        assert.match(text, /End task as failed/);
        assert.match(text, /Blocked: irreversible effects/);
        assert.equal(text.includes('recompute'), false);
        assert.equal(text.includes('abort'), false);

        const rollback = fixture.shadow.querySelector(
            'input[data-rpa-product-field="recovery-option"][value="rollback-1"]',
        ) as HTMLInputElement;
        assert.equal(rollback.disabled, true, 'non-eligible option is disabled');

        (fixture.shadow.querySelector('[data-rpa-product-action="choose-recovery"]') as HTMLButtonElement).click();
        const chooseCall = fixture.calls.find((call) => call.name === 'chooseRecovery');
        assert.ok(chooseCall);
        assert.deepEqual(chooseCall.args, ['retry-1']);
    } finally {
        fixture.cleanup();
    }
});

test('takeover card renders only backend-approved guidance modes and Return Control when active', () => {
    const offered: InteractionRequest = {
        kind: 'takeover',
        interactionToken: 'tok-4',
        reason: 'The checkout flow requires 2FA that only a human can complete.',
        scope: 'workspace',
        guidanceModes: ['manual', 'teach'],
    };
    const fixture = mount(waitingView(offered));
    try {
        openPanel(fixture);
        const text = bodyText(fixture);
        assert.match(text, /Manual control needed/);
        assert.match(text, /Take Over/);
        assert.match(text, /Teach by example/);
        assert.equal(text.includes('Annotate page'), false, 'annotate mode not offered by the backend');

        (fixture.shadow.querySelector('[data-rpa-product-action="guidance-manual"]') as HTMLButtonElement).click();
        const guidanceCall = fixture.calls.find((call) => call.name === 'beginHumanGuidance');
        assert.ok(guidanceCall);
        assert.deepEqual(guidanceCall.args, ['manual']);

        fixture.handle.setView(
            waitingView({ ...offered, activeMode: 'manual' }),
        );
        assert.match(bodyText(fixture), /You are in control/);
        (fixture.shadow.querySelector('[data-rpa-product-action="return-control"]') as HTMLButtonElement).click();
        assert.equal(fixture.calls.some((call) => call.name === 'returnControl'), true);
    } finally {
        fixture.cleanup();
    }
});

test('dev-override banner appears only when a dev override is applied to the task', () => {
    const fixture = mount(runningView({ devOverride: { model: 'claude-3.5', executionMode: 'program' } }));
    try {
        openPanel(fixture);
        assert.ok(fixture.shadow.querySelector('[data-rpa-product-dev-banner]'), 'override banner rendered');
        assert.match(bodyText(fixture), /Dev override/);
    } finally {
        fixture.cleanup();
    }
});