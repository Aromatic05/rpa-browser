/**
 * Workspace Library surface (spec §9.3). Dependency-oriented and user-facing:
 * Automations, Procedures & Recovery, Demonstrations, and Page Knowledge.
 * Never renders raw DSL/YAML/step JSON; never presents Step as an asset.
 */
import { isActiveActivity } from '../model/projection.js';
import {
    button,
    card,
    el,
    emptyState,
    hint,
    isMutationDisabled,
    sectionTitle,
    type SurfaceContext,
} from '../components/common.js';

const section = (key: string, title: string): HTMLElement => {
    const wrap = el('div', 'rpa-library-section');
    wrap.dataset.rpaProductLib = key;
    wrap.append(el('div', 'rpa-library-heading', [title]));
    return wrap;
};

const libraryItem = (name: string, meta: string, action?: HTMLButtonElement | null): HTMLElement => {
    const item = el('div', 'rpa-library-item');
    const main = el('div', 'rpa-library-main');
    main.append(
        el('div', 'rpa-library-name', [name]),
        el('div', 'rpa-library-meta', [meta]),
    );
    item.append(main);
    if (action) {
        item.append(action);
    }
    return item;
};

const healthMarker = (health?: string): string => {
    if (health === 'needs_review') {return ' · needs review';}
    if (health === 'broken') {return ' · broken reference';}
    if (health === 'unknown') {return ' · health unknown';}
    return '';
};

const renderPlayback = (ctx: SurfaceContext): HTMLElement | undefined => {
    const {playback, playbackPending, playbackError} = ctx.view;
    if (!playback && !playbackPending && !playbackError) {return undefined;}
    const contents: HTMLElement[] = [];
    if (playback) {
        const title = {
            running: 'Replay in progress',
            completed: playback.failure ? 'Replay completed with errors' : 'Replay completed',
            failed: 'Replay stopped',
            canceled: 'Replay canceled',
        }[playback.phase];
        contents.push(el('strong', undefined, [title]));
        contents.push(hint(`${playback.recordingName ?? 'Unsaved recording'} · ${playback.completed} / ${playback.total} actions processed`));
        if (playback.failure) {
            const {index, code, fallbackConflict} = playback.failure;
            const reason = code === 'ERR_AMBIGUOUS'
                ? fallbackConflict ? 'The backup clues matched more than one element.' : 'The target matched more than one element.'
                : code === 'ERR_NOT_FOUND' || code === 'ERR_STALE' || code === 'ERR_UNRESOLVED'
                    ? 'The recorded target could not be found on the current page.'
                    : code === 'ERR_TIMEOUT' || code === 'ERR_PAGE_NOT_READY'
                        ? 'The page or target did not become ready in time.'
                        : 'Check the current page and try replaying again.';
            contents.push(hint(index === undefined ? reason : `Action ${index + 1}: ${reason}`));
        }
        if (playback.phase === 'running') {
            contents.push(button('Stop replay', ctx.commands.stopPlayback, 'danger', {
                disabled: isMutationDisabled(ctx) || playbackPending,
                dataAction: 'stop-playback',
            }));
        }
    }
    if (playbackPending) {contents.push(hint('Waiting for the playback request…'));}
    if (playbackError) {contents.push(hint(playbackError));}
    const panel = card(contents);
    panel.dataset.rpaProductPlayback = playback?.phase ?? 'pending';
    panel.setAttribute('role', 'status');
    return panel;
};

export const renderLibrarySurface = (root: HTMLElement, ctx: SurfaceContext): void => {
    root.append(sectionTitle('Library'));
    const library = ctx.view.librarySummary;
    const mutationsDisabled = isMutationDisabled(ctx);
    const workspaceBusy = isActiveActivity(ctx.view);
    if (ctx.view.libraryUnavailable) {
        root.append(
            card([hint('This workspace service does not expose a Library projection yet; the lists below may be incomplete.')]),
        );
    }

    const automations = section('automations', 'Automations');
    if (library.automations.length === 0) {
        automations.append(emptyState('No automations yet.'));
    }
    for (const automation of library.automations) {
        automations.append(
            libraryItem(
                automation.name,
                `${automation.description ?? automation.status ?? 'Saved automation'}${healthMarker(automation.health)}`,
            ),
        );
    }
    root.append(automations);

    const proceduresAndRecovery = section('procedures', 'Procedures & Recovery');
    const procedureItems = library.procedures.map((procedure) =>
        libraryItem(procedure.name, `Procedure · callable from workflows${healthMarker(procedure.health)}`),
    );
    const recoveryItems = library.recoveries.map((recovery) =>
        libraryItem(recovery.name, `Recovery · used by the runner on failure${healthMarker(recovery.health)}`),
    );
    if (procedureItems.length === 0 && recoveryItems.length === 0) {
        proceduresAndRecovery.append(emptyState('No procedures or recoveries yet.'));
    }
    for (const item of procedureItems) {
        proceduresAndRecovery.append(item);
    }
    for (const item of recoveryItems) {
        proceduresAndRecovery.append(item);
    }
    root.append(proceduresAndRecovery);

    const demonstrations = section('demonstrations', 'Demonstrations');
    const playback = renderPlayback(ctx);
    if (playback) {demonstrations.append(playback);}
    if (library.demonstrations.length === 0) {
        demonstrations.append(emptyState('No demonstrations yet.'));
    }
    for (const demonstration of library.demonstrations) {
        demonstrations.append(
            libraryItem(
                demonstration.name,
                `${String(demonstration.stepCount)} recorded actions${healthMarker(demonstration.health)}`,
                ctx.view.playbackAvailable ? button(
                    'Replay',
                    () => {ctx.commands.replayDemonstration(demonstration.name);},
                    'ghost',
                    {
                        disabled: mutationsDisabled || workspaceBusy || ctx.view.playbackPending
                            || demonstration.stepCount === 0 || demonstration.health === 'broken',
                        ariaLabel: `Replay ${demonstration.name}`,
                        dataAction: 'replay',
                    },
                ) : undefined,
            ),
        );
    }
    root.append(demonstrations);

    const pageKnowledge = section('pageKnowledge', 'Page Knowledge');
    if (library.pageKnowledge.length === 0) {
        pageKnowledge.append(emptyState('No Page Knowledge yet.'));
    }
    for (const knowledge of library.pageKnowledge) {
        const parts = [
        knowledge.pageKind,
        knowledge.entityCount === 1
            ? '1 entity'
            : knowledge.entityCount > 1
              ? `${String(knowledge.entityCount)} entities`
              : '',
        knowledge.urlPattern,
        ].filter((part): part is string => part !== undefined && part.length > 0);
        const marker = healthMarker(knowledge.health);
        pageKnowledge.append(
            libraryItem(
                knowledge.label,
                `${parts.join(' · ')}${marker}`,
                button(
                    'Annotate/Edit',
                    () => {
                        ctx.commands.editPageKnowledge({ profileName: knowledge.profileName });
                    },
                    'ghost',
                    { disabled: mutationsDisabled || workspaceBusy, dataAction: 'edit-page-knowledge' },
                ),
            ),
        );
    }
    root.append(pageKnowledge);

    if (workspaceBusy) {
        root.append(card([hint('The workspace is in use. Editing is paused.')]));
    }
};
