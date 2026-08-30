/**
 * Home / Composer surface plus the first-class Teach and Annotate authoring
 * entry points (spec §5). The Teach surface renders the structured
 * procedure/recovery setup and the secondary Basic Demonstration path; the
 * Annotate surface is a thin bridge to the existing annotator canvas.
 */
import type { TeachKind } from '../model/contracts.js';
import { isActiveActivity } from '../model/projection.js';
import {
    button,
    card,
    cardTitle,
    el,
    elAttrs,
    fieldLabel,
    hint,
    isMutationDisabled,
    muted,
    sectionTitle,
    statusLine,
    stopButton,
    type SurfaceContext,
} from '../components/common.js';

const SUGGESTIONS = ['Order form', 'Sync contacts', 'Summarize this page'];

const TEACH_KIND_OPTIONS: Array<{ value: TeachKind; label: string; hint: string; structured: boolean }> = [
    {
        value: 'procedure',
        label: 'Reusable business procedure',
        hint: 'Saves a structured Procedure the agent can call from workflows.',
        structured: true,
    },
    {
        value: 'recovery',
        label: 'Error recovery',
        hint: 'Saves a structured Recovery the agent uses when a step fails.',
        structured: true,
    },
    {
        value: 'demonstration',
        label: 'Basic demonstration',
        hint: 'Secondary: records a raw example for replay.',
        structured: false,
    },
];

const activeActivitySummary = (ctx: SurfaceContext): { title: string; statusText: string } => {
    if (ctx.view.activeTask) {
        const waiting = ctx.view.activeTask.status === 'waiting_for_user';
        return {
            title: ctx.view.activeTask.title,
            statusText: waiting ? 'Waiting for you' : 'Running',
        };
    }
    if (ctx.view.authoring?.teach) {
        return { title: 'Teaching in progress', statusText: 'Running' };
    }
    if (ctx.view.authoring?.annotate?.active) {
        return { title: 'Annotating in progress', statusText: 'Running' };
    }
    return { title: 'Playback in progress', statusText: 'Running' };
};

/** Spec §5.2: never queue; open the current activity or stop it. */
const renderActivityGuard = (root: HTMLElement, ctx: SurfaceContext): void => {
    const summary = activeActivitySummary(ctx);
    const guard = card([
        cardTitle('This workspace is already in use.'),
        muted(summary.title),
        statusLine('●', summary.statusText, 'running', true),
    ]);
    guard.dataset.rpaProductGuard = 'true';
    const row = el('div', 'rpa-row');
    row.append(
        button(
            'Open current activity',
            () => {
                ctx.commands.openCurrentActivity();
            },
            'primary',
            { dataAction: 'open-current' },
        ),
    );
    if (ctx.view.activeTask) {
        row.append(stopButton(ctx));
    }
    guard.append(row);
    root.append(guard);
};

const renderErrorStrip = (root: HTMLElement, ctx: SurfaceContext): void => {
    const startError = ctx.view.startError;
    if (!startError) {
        return;
    }
    const copy =
        startError.kind === 'service'
            ? 'Agent service is not reachable.'
            : startError.kind === 'auth'
              ? 'Could not authenticate the agent session. See Developer mode for details.'
              : 'No active workspace for this tab.';
    const strip = elAttrs('div', 'rpa-error-strip', { 'data-rpa-product-error': startError.kind }, [copy]);
    root.append(strip);
};

const renderComposer = (root: HTMLElement, ctx: SurfaceContext): void => {
    root.append(sectionTitle('New task'));

    const prompt = ctx.ui.composer.trim();
    const startDisabled = prompt.length === 0 || isMutationDisabled(ctx) || ctx.view.startError !== undefined;

    const textarea = document.createElement('textarea');
    textarea.className = 'rpa-textarea';
    textarea.placeholder = 'Describe what the agent should do…';
    textarea.dataset.rpaProductComposer = 'true';
    textarea.value = ctx.ui.composer;

    const startRow = el('div', 'rpa-row');
    const startButton = button(
        'Start Task',
        () => {
            const value = ctx.ui.composer.trim();
            if (value.length > 0) {
                ctx.commands.startTask(value);
            }
        },
        'primary',
        { disabled: startDisabled, dataAction: 'start', ariaLabel: 'Start task' },
    );
    startRow.append(startButton);

    const canStart = (): boolean =>
        ctx.ui.composer.trim().length > 0 && !isMutationDisabled(ctx) && ctx.view.startError === undefined;

    textarea.addEventListener('input', () => {
        ctx.ui.composer = textarea.value;
        startButton.disabled = !canStart();
    });
    textarea.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const value = ctx.ui.composer.trim();
            if (value.length > 0 && canStart()) {
                ctx.commands.startTask(value);
            }
        }
    });

    const example = hint('e.g. "Fill the order form on this page and submit the delivery address I entered."');

    const chips = el('div', 'rpa-row');
    for (const suggestion of SUGGESTIONS) {
        chips.append(
            button(
                suggestion,
                () => {
                    ctx.ui.composer = suggestion;
                    ctx.rerender();
                },
                'ghost',
                { dataAction: `suggest-${suggestion}` },
            ),
        );
    }

    const helper = prompt.length === 0 ? muted('Describe the task first.') : null;

    const composerChildren: Array<Node | string> = [textarea, example, chips];
    if (helper) {
        composerChildren.push(helper);
    }
    composerChildren.push(startRow);
    const composerCard = card(composerChildren);
    composerCard.dataset.rpaProductSurfaceBlock = 'composer';
    root.append(composerCard);
    renderErrorStrip(root, ctx);

    root.append(el('div', 'rpa-block', [sectionTitle('Help the agent learn this workspace')]));
    const learnCard = card([
        button(
            'Teach a workflow',
            () => {
                ctx.commands.openTeach();
            },
            'ghost',
            { dataAction: 'teach', ariaLabel: 'Teach a workflow' },
        ),
        button(
            'Annotate this page',
            () => {
                ctx.commands.openAnnotate();
            },
            'ghost',
            { dataAction: 'annotate', ariaLabel: 'Annotate this page' },
        ),
        muted('Teach structured procedures or record a demonstration; annotate business objects for Page Knowledge.'),
    ]);
    learnCard.dataset.rpaProductSurfaceBlock = 'learn';
    root.append(learnCard);
};

export const renderHomeSurface = (root: HTMLElement, ctx: SurfaceContext): void => {
    if (isActiveActivity(ctx.view)) {
        renderActivityGuard(root, ctx);
        return;
    }
    renderComposer(root, ctx);
};

const renderTeachStatus = (root: HTMLElement, ctx: SurfaceContext): void => {
    const teach = ctx.view.authoring?.teach;
    if (!teach) {
        return;
    }
    if (teach.phase === 'recording') {
        const pill = statusLine('●', `Teaching · ${String(teach.stepCount)} actions`, 'running', true);
        const row = el('div', 'rpa-row');
        row.append(
            pill,
            button(
                'Stop & Review',
                () => {
                    ctx.commands.stopTeach();
                },
                'primary',
                { dataAction: 'stop-teach' },
            ),
        );
        root.append(card([row]));
        return;
    }
    if (teach.phase === 'review') {
        const review = teach.review;
        const saveLabel = teach.teachKind === 'procedure' ? 'Save Procedure' : teach.teachKind === 'recovery' ? 'Save Recovery' : 'Save Demonstration';
        const summary = review
            ? [hint(review.summary), ...review.stepSummaries.map((line) => muted(line))]
            : [hint('Review the recorded teaching before saving.')];
        const row = el('div', 'rpa-row');
        row.append(
            button(saveLabel, () => { ctx.commands.saveTeach(); }, 'primary', {
                disabled: isMutationDisabled(ctx) || (review ? !review.canSave : false),
                dataAction: 'save-teach',
            }),
            button('Discard', () => { ctx.commands.discardTeach(); }, 'danger', { dataAction: 'discard-teach' }),
        );
        root.append(card([...summary, row]));
        return;
    }
    if (teach.phase === 'saving') {
        root.append(card([muted('Saving…')]));
    }
};

export const renderTeachSurface = (root: HTMLElement, ctx: SurfaceContext): void => {
    root.append(sectionTitle('Teach the agent'));

    const isStructured = ctx.ui.teachKind === 'procedure' || ctx.ui.teachKind === 'recovery';

    const kindField = el('div', 'rpa-block');
    kindField.append(fieldLabel('What are you teaching?'));
    for (const option of TEACH_KIND_OPTIONS) {
        const row = el('label', 'rpa-teach-option');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'rpa-teach-kind';
        radio.value = option.value;
        radio.checked = ctx.ui.teachKind === option.value;
        radio.dataset.rpaProductField = 'teach-kind';
        radio.addEventListener('change', () => {
            if (radio.checked) {
                ctx.ui.teachKind = option.value;
                ctx.rerender();
            }
        });
        row.append(radio, el('span', undefined, [option.label]), hint(option.hint));
        kindField.append(row);
    }
    root.append(card([kindField]));

    root.append(
        hint(
            isStructured
                ? 'Structured teaching saves a reusable Procedure or Recovery the agent can call on.'
                : 'Basic demonstration is the secondary path: a raw recorded example for replay.',
        ),
    );

    let selectedArea = '';
    if (isStructured) {
        const areas = ctx.view.authoring?.teach?.businessAreas ?? [];
        const areaField = el('div', 'rpa-block');
        areaField.append(fieldLabel('Business area'));
        const select = document.createElement('select');
        select.className = 'rpa-select';
        select.dataset.rpaProductField = 'business-area';
        const placeholder = el('option', undefined, ['Choose a business area']);
        placeholder.setAttribute('value', '');
        select.append(placeholder);
        for (const area of areas) {
            const option = el('option', undefined, [`${area.label} · ${String(area.entityCount)} entities`]);
            option.setAttribute('value', area.profileName);
            select.append(option);
        }
        select.value = ctx.ui.businessArea || '';
        select.addEventListener('change', () => {
            ctx.ui.businessArea = select.value;
            ctx.rerender();
        });
        selectedArea = select.value;
        areaField.append(select);
        if (areas.length === 0) {
            areaField.append(hint('No business area yet — annotate this page first.'));
            areaField.append(
                button(
                    'Annotate this page',
                    () => {
                        ctx.commands.openAnnotate();
                    },
                    'ghost',
                    { dataAction: 'teach-annotate' },
                ),
            );
        }
        root.append(card([areaField]));
    }

    const startDisabled = isMutationDisabled(ctx) || (isStructured && selectedArea.length === 0);
    const startRow = el('div', 'rpa-row');
    startRow.append(
        button(
            'Start Teaching',
            () => {
                const area = isStructured && selectedArea.length > 0 ? selectedArea : undefined;
                ctx.commands.startTeach(ctx.ui.teachKind, area);
            },
            'primary',
            { disabled: startDisabled, dataAction: 'start-teach' },
        ),
    );
    root.append(startRow);

    renderTeachStatus(root, ctx);
};

export const renderAnnotateSurface = (root: HTMLElement, ctx: SurfaceContext): void => {
    root.append(sectionTitle('Annotate this page'));
    const annotate = ctx.view.authoring?.annotate;
    const cardBody: Array<Node | string> = [
        muted('Open the annotator canvas to label this page’s business objects into Page Knowledge.'),
    ];
    if (annotate?.active) {
        cardBody.push(statusLine('✎', 'Annotating on the page', 'info'));
        if (annotate.stage) {
            cardBody.push(muted(`Stage: ${annotate.stage}`));
        }
    }
    if (annotate?.savedSummary) {
        cardBody.push(
            muted(
                `Saved Page Knowledge: ${annotate.savedSummary.profileName} · ${String(annotate.savedSummary.entityCount)} objects`,
            ),
        );
    }
    const row = el('div', 'rpa-row');
    row.append(
        button('Open Annotator', () => { ctx.commands.openAnnotate(); }, 'primary', { dataAction: 'open-annotator' }),
    );
    if (annotate?.active) {
        row.append(
            button('Close Annotator', () => { ctx.commands.closeAnnotate(); }, 'ghost', { dataAction: 'close-annotator' }),
        );
    }
    cardBody.push(row);
    root.append(card(cardBody));
};