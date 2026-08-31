/**
 * Current Task surface (spec §6/§7/§8): truthful Running/phase status, the
 * sanitized activity timeline, waiting interaction cards, and the two-step
 * Stop. Terminal tasks render the Result view.
 */
import type { ActivityEvent, AgentTaskView } from '../model/contracts.js';
import { isTerminalStatus, phaseLabel, relativeTimeLabel } from '../model/projection.js';
import {
    button,
    card,
    cardTitle,
    el,
    elAttrs,
    icon,
    muted,
    sectionTitle,
    statusLine,
    stopButton,
    type SurfaceContext,
} from '../components/common.js';
import { renderInteractionCard } from '../components/interactions.js';
import { renderResultView } from './result.js';

const renderTaskStatus = (task: AgentTaskView): HTMLElement => {
    if (task.status === 'running') {
        const text = task.phase ? `Running · ${phaseLabel(task.phase)}` : 'Running';
        return statusLine('●', text, 'running', true);
    }
    if (task.status === 'waiting_for_user') {
        return statusLine('●', 'Waiting for you', 'waiting', true);
    }
    return statusLine('●', 'Running', 'running', false);
};

/** Spec §10: visible only while a dev override is applied to the current task. */
const renderDevOverrideBanner = (task: AgentTaskView): HTMLElement | null => {
    const override = task.devOverride;
    if (!override) {
        return null;
    }
    const parts: string[] = [];
    if (override.model) {
        parts.push(`model=${override.model}`);
    }
    if (override.executionMode) {
        parts.push(`mode=${override.executionMode}`);
    }
    return elAttrs('div', 'rpa-dev-banner', { 'data-rpa-product-dev-banner': 'true' }, [`⚙ Dev override: ${parts.join(' · ')}`]);
};

type TimelineMeta = { glyph: string; text: string; toneClass: string };

const timelineMeta = (event: ActivityEvent): TimelineMeta => {
    switch (event.kind) {
        case 'task_created':
            return { glyph: '✓', text: 'Task started', toneClass: '' };
        case 'phase_changed':
            return { glyph: '●', text: `Now ${phaseLabel(event.phase)}`, toneClass: '' };
        case 'activity':
            return { glyph: '~', text: event.summary, toneClass: '' };
        case 'interaction_requested':
            return { glyph: '❓', text: event.summary, toneClass: '' };
        case 'interaction_resolved':
            return { glyph: '✓', text: `Resolved: ${event.summary}`, toneClass: 'rpa-timeline-item--resolved' };
        case 'human_guidance_started':
            return { glyph: '⚑', text: event.summary, toneClass: '' };
        case 'human_guidance_completed':
            return { glyph: '⚑', text: event.summary, toneClass: 'rpa-timeline-item--resolved' };
        case 'effect_applied':
            return {
                glyph: '~',
                text: `${event.status === 'ok' ? 'Applied' : 'Failed'}: ${event.summary}`,
                toneClass: 'rpa-timeline-item--effect',
            };
        case 'world_conflict':
            return { glyph: '⚠', text: `Conflict: ${event.summary}`, toneClass: 'rpa-timeline-item--conflict' };
        case 'task_terminated':
            return { glyph: '⊘', text: `Task ${event.outcome}`, toneClass: '' };
        case 'report_ready':
            return { glyph: '✓', text: 'Report ready', toneClass: 'rpa-timeline-item--resolved' };
    }
};

const renderTimeline = (ctx: SurfaceContext, task: AgentTaskView): HTMLElement => {
    const list = el('ul', 'rpa-timeline');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-live', 'off');
    for (const event of task.timeline) {
        const meta = timelineMeta(event);
        const item = el('li', 'rpa-timeline-item');
        if (meta.toneClass) {
            item.classList.add(meta.toneClass);
        }
        item.append(icon(meta.glyph));
        item.append(el('span', undefined, [meta.text]));
        item.append(el('span', 'rpa-timeline-time', [relativeTimeLabel(event.at, ctx.now())]));
        list.append(item);
    }
    return list;
};

/** Indeterminate progress: never a fabricated percentage (spec §6). */
const renderIndeterminate = (): HTMLElement => {
    const wrap = el('div', 'rpa-indeterminate-wrap');
    wrap.append(muted('Working…'), el('div', 'rpa-indeterminate'));
    return wrap;
};

export const renderTaskSurface = (root: HTMLElement, ctx: SurfaceContext): void => {
    const task = ctx.view.activeTask;
    if (!task) {
        return;
    }
    if (isTerminalStatus(task.status)) {
        renderResultView(root, ctx, task);
        return;
    }

    const header = card([cardTitle(task.title), renderTaskStatus(task)]);
    header.dataset.rpaProductBlock = 'task-header';
    root.append(header);

    const devBanner = renderDevOverrideBanner(task);
    if (devBanner) {
        root.append(devBanner);
    }

    if (task.status === 'waiting_for_user') {
        if (task.interaction) {
            renderInteractionCard(root, ctx, task.interaction);
        } else {
            root.append(card([statusLine('●', 'Preparing…', 'running', false)]));
        }
        return;
    }

    const actions = el('div', 'rpa-row');
    actions.append(stopButton(ctx));
    actions.append(
        button('History', () => { ctx.commands.navigate('history'); }, 'ghost', { dataAction: 'history' }),
    );
    root.append(card([sectionTitle('Timeline'), renderTimeline(ctx, task), renderIndeterminate(), actions]));
};