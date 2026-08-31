import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bodyText,
    idleView,
    libraryView,
    mount,
    openPanel,
    runningTask,
} from './harness.js';
import type { AgentTaskView, WorkspaceProductView } from '../model/contracts.js';

const terminalTask = (status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): AgentTaskView =>
    runningTask({
        status,
        title: 'Place order',
        result: {
            outcome: status,
            output: status === 'completed' ? 'Order #A-102 placed with vendor.' : undefined,
            errorMessage: status === 'failed' ? 'The vendor API rejected the request.' : undefined,
            effectsCount: 3,
            reportAvailable: status === 'completed',
            saveEligible: status === 'completed',
        },
    });

const terminalView = (task: AgentTaskView): WorkspaceProductView => ({
    workspace: 'ws-1',
    reservation: 'task',
    connection: 'connected',
    activeTask: task,
    librarySummary: {
        automations: [],
        procedures: [],
        recoveries: [],
        demonstrations: [],
        pageKnowledge: [],
    },
    history: [],
});

test('completed result shows output, effect count and Save Automation only when eligible', () => {
    const fixture = mount(terminalView(terminalTask('completed')));
    try {
        openPanel(fixture);
        const text = bodyText(fixture);
        assert.match(text, /Task completed/);
        assert.match(text, /Order #A-102 placed with vendor\./);
        assert.match(text, /Effects applied: 3/);

        (fixture.shadow.querySelector('[data-rpa-product-action="save-automation"]') as HTMLButtonElement).click();
        const name = fixture.shadow.querySelector('[data-rpa-product-field="automation-name"]') as HTMLInputElement;
        assert.ok(name, 'saving opens an explicit naming step instead of firing a no-op');
        name.value = 'Place order automation';
        name.dispatchEvent(new fixture.dom.window.Event('input', {bubbles: true}));
        (fixture.shadow.querySelector('[data-rpa-product-action="confirm-save-automation"]') as HTMLButtonElement).click();
        const saveCall = fixture.calls.find((call) => call.name === 'saveAutomation');
        assert.deepEqual(saveCall?.args, ['Place order automation']);

        (fixture.shadow.querySelector('[data-rpa-product-action="new-task"]') as HTMLButtonElement).click();
        assert.equal(fixture.calls.some((call) => call.name === 'newTask'), true);
    } finally {
        fixture.cleanup();
    }
});

test('completed task without backend eligibility hides Save Automation', () => {
    const task = terminalTask('completed');
    task.result = { ...task.result!, saveEligible: false };
    const fixture = mount(terminalView(task));
    try {
        openPanel(fixture);
        assert.equal(
            fixture.shadow.querySelector('[data-rpa-product-action="save-automation"]'),
            null,
            'no Save Automation without eligibility',
        );
    } finally {
        fixture.cleanup();
    }
});

test('interrupted result states non-resumable and never offers Resume', () => {
    const fixture = mount(terminalView(terminalTask('interrupted')));
    try {
        openPanel(fixture);
        const text = bodyText(fixture);
        assert.match(text, /Task interrupted/);
        assert.match(text, /not resumable/);
        assert.equal(text.includes('Resume'), false, 'no Resume for a non-resumable task');
    } finally {
        fixture.cleanup();
    }
});

test('failed result points to Developer mode instead of dumping the raw report', () => {
    const fixture = mount(terminalView(terminalTask('failed')));
    try {
        openPanel(fixture);
        const text = bodyText(fixture);
        assert.match(text, /Task failed/);
        assert.match(text, /See Developer mode for the full report\./);
        assert.equal(text.includes('sessionId'), false);
    } finally {
        fixture.cleanup();
    }
});

test('History lists terminal tasks without a fake click affordance', () => {
    const view: WorkspaceProductView = {
        ...libraryView(),
        activeTask: runningTask({ status: 'waiting_for_user' }),
        history: [
            { taskId: 'task-old-2', outcome: 'failed', title: 'Book meeting', endedAt: 86_400_000 },
            { taskId: 'task-old-1', outcome: 'completed', title: 'Place order', endedAt: 7_200_000 },
        ],
    };
    const fixture = mount(view);
    try {
        openPanel(fixture);
        (fixture.shadow.querySelector('[data-rpa-product-nav="history"]') as HTMLButtonElement).click();
        assert.ok(fixture.shadow.querySelector('[data-rpa-product-history-pinned]'), 'active task is pinned');
        assert.match(bodyText(fixture), /Place order/);
        assert.match(bodyText(fixture), /Book meeting/);

        const entry = fixture.shadow.querySelector('[data-rpa-product-history-entry]') as HTMLElement;
        entry.click();
        assert.equal(
            fixture.calls.some((call) => call.name === 'selectHistoryEntry'),
            false,
            'history stays read-only until a real historical task detail route exists',
        );
    } finally {
        fixture.cleanup();
    }
});

test('History empty state offers a New Task CTA', () => {
    const fixture = mount(idleView());
    try {
        openPanel(fixture);
        (fixture.shadow.querySelector('[data-rpa-product-nav="history"]') as HTMLButtonElement).click();
        assert.match(bodyText(fixture), /No completed tasks yet\./);
        (fixture.shadow.querySelector('[data-rpa-product-action="new-task"]') as HTMLButtonElement).click();
        assert.equal(fixture.calls.some((call) => call.name === 'newTask'), true);
    } finally {
        fixture.cleanup();
    }
});