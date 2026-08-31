/**
 * Terminal Result and History surfaces (spec §9). Result renders the four
 * terminal outcomes with truthful copy; History lists terminal tasks with the
 * active task pinned, newest first. Raw reports stay in Developer Mode.
 */
import type { AgentTaskView, TaskHistoryEntry, TaskOutcome } from '../model/contracts.js';
import { isTerminalStatus, relativeTimeLabel } from '../model/projection.js';
import {
    button,
    card,
    cardTitle,
    el,
    emptyState,
    hint,
    muted,
    sectionTitle,
    statusLine,
    type SurfaceContext,
} from '../components/common.js';

const OUTCOME_META: Record<TaskOutcome, { glyph: string; label: string; tone: string }> = {
    completed: { glyph: '✓', label: 'Task completed', tone: 'success' },
    failed: { glyph: '✗', label: 'Task failed', tone: 'error' },
    cancelled: { glyph: '⊘', label: 'Task stopped', tone: 'muted' },
    interrupted: { glyph: '⏸', label: 'Task interrupted', tone: 'info' },
};

const primaryCopy = (task: AgentTaskView, outcome: TaskOutcome): Node => {
    if (outcome === 'completed') {
        return task.result?.output ? muted(`Output: ${task.result.output}`) : muted('The task finished successfully.');
    }
    if (outcome === 'failed') {
        const wrapper = el('div', undefined, [muted(task.error?.message ?? 'The task failed.')]);
        wrapper.append(hint('See Developer mode for the full report.'));
        return wrapper;
    }
    if (outcome === 'cancelled') {
        return muted('You stopped this task.');
    }
    return muted('The agent service restarted. This task is not resumable.');
};

/** Spec §9.1: terminal result view for the current task. */
export const renderResultView = (root: HTMLElement, ctx: SurfaceContext, task: AgentTaskView): void => {
    const outcome = isTerminalStatus(task.status) ? task.status : undefined;
    if (!outcome) {
        return;
    }
    const meta = OUTCOME_META[outcome];
    const header = card([statusLine(meta.glyph, meta.label, meta.tone), cardTitle(task.title)]);
    header.dataset.rpaProductBlock = 'result';
    root.append(header);

    const body = card([primaryCopy(task, outcome)]);
    const result = task.result;
    const reportCopy = result?.reportAvailable ? ' · Report available' : '';
    body.append(muted(`Effects applied: ${String(result?.effectsCount ?? 0)}${reportCopy}`));
    const row = el('div', 'rpa-row');
    row.append(
        button('New Task', () => { ctx.commands.newTask(); }, 'primary', { dataAction: 'new-task' }),
        button('Retry', () => { ctx.commands.retry(); }, 'ghost', { dataAction: 'retry' }),
    );
    if (outcome === 'completed' && result?.saveEligible) {
        row.append(
            button('Save Automation', () => { ctx.commands.saveAutomation(); }, 'ghost', {
                disabled: ctx.view.connection !== 'connected',
                dataAction: 'save-automation',
            }),
        );
    }
    row.append(
        button('View Details', () => { ctx.commands.viewDetails(); }, 'ghost', { dataAction: 'view-details' }),
    );
    body.append(row);
    root.append(body);
};

const renderHistoryEntry = (ctx: SurfaceContext, entry: TaskHistoryEntry): HTMLElement => {
    const meta = OUTCOME_META[entry.outcome];
    const entryCard = card([
        statusLine(meta.glyph, meta.label, meta.tone),
        el('div', 'rpa-library-name', [entry.title]),
        muted(relativeTimeLabel(entry.endedAt, ctx.now())),
    ]);
    entryCard.dataset.rpaProductHistoryEntry = 'true';
    entryCard.classList.add('rpa-history-card');
    entryCard.addEventListener('click', () => {
        ctx.commands.selectHistoryEntry(entry.taskId);
    });
    return entryCard;
};

/** Spec §9.2: active task pinned on top, terminal tasks newest first. */
export const renderHistorySurface = (root: HTMLElement, ctx: SurfaceContext): void => {
    root.append(sectionTitle('History'));

    const active = ctx.view.activeTask;
    if (active && !isTerminalStatus(active.status)) {
        const pinned = card([
            muted('Active (pinned)'),
            el('div', 'rpa-row', [
                el('div', 'rpa-library-name', [active.title]),
                statusLine('●', 'Running', 'running', true),
            ]),
        ]);
        pinned.dataset.rpaProductHistoryPinned = 'true';
        root.append(pinned);
    }

    const terminal = [...ctx.view.history].sort((a, b) => b.endedAt - a.endedAt);
    if (terminal.length === 0) {
        const empty = card([emptyState('No completed tasks yet.')]);
        empty.append(
            button('New Task', () => { ctx.commands.newTask(); }, 'primary', { dataAction: 'new-task' }),
        );
        root.append(empty);
        return;
    }
    for (const entry of terminal) {
        root.append(renderHistoryEntry(ctx, entry));
    }
};