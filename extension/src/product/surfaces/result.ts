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

const failedTaskCopy = (task: AgentTaskView): string => {
    if (task.error?.code === 'ERR_AGENT_MODEL_REQUEST_FAILED') {
        return 'The model service could not complete this request. Check Model settings or service availability, then try again.';
    }
    return task.error?.message ?? 'The task failed.';
};

const primaryCopy = (task: AgentTaskView, outcome: TaskOutcome): Node => {
    if (outcome === 'completed') {
        return task.result?.output ? muted(`Output: ${task.result.output}`) : muted('The task finished successfully.');
    }
    if (outcome === 'failed') {
        const wrapper = el('div', undefined, [muted(failedTaskCopy(task))]);
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
    row.append(button('New Task', () => { ctx.commands.newTask(); }, 'primary', { dataAction: 'new-task' }));
    if (outcome === 'completed' && result?.saveEligible) {
        if (!ctx.ui.automationSaveOpen && ctx.view.automationSave?.status !== 'saved') {
            row.append(
                button('Save Automation', () => {
                    ctx.ui.automationSaveOpen = true;
                    ctx.ui.automationName = task.title;
                    ctx.rerender();
                }, 'ghost', {
                    disabled: ctx.view.connection !== 'connected',
                    dataAction: 'save-automation',
                }),
            );
        }
    }
    body.append(row);

    if (outcome === 'completed' && result?.saveEligible && ctx.ui.automationSaveOpen) {
        const saveCard = el('div', 'rpa-block');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rpa-input';
        input.maxLength = 80;
        input.value = ctx.ui.automationName;
        input.placeholder = 'Automation name';
        input.dataset.rpaProductField = 'automation-name';
        input.addEventListener('input', () => {ctx.ui.automationName = input.value;});
        const saveState = ctx.view.automationSave;
        if (saveState?.status === 'saved') {
            saveCard.append(statusLine('✓', `Saved as ${saveState.name}`, 'success'));
        } else {
            saveCard.append(input);
            if (saveState?.status === 'conflict' || saveState?.status === 'failed') {
                saveCard.append(muted(saveState.message ?? 'Saving failed.'));
            } else if (saveState?.status === 'saving') {
                saveCard.append(muted('Saving…'));
            }
            const saveRow = el('div', 'rpa-row');
            saveRow.append(
                button('Save', () => {ctx.commands.saveAutomation(ctx.ui.automationName);}, 'primary', {
                    disabled: ctx.view.connection !== 'connected' || saveState?.status === 'saving',
                    dataAction: 'confirm-save-automation',
                }),
                button('Cancel', () => {
                    ctx.ui.automationSaveOpen = false;
                    ctx.rerender();
                }, 'ghost', {dataAction: 'cancel-save-automation'}),
            );
            saveCard.append(saveRow);
        }
        body.append(saveCard);
    }
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