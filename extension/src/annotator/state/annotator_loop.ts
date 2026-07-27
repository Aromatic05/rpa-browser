import type { AnnotatorClient } from '../protocol/annotator_client.js';
import type { SessionStore, SessionDraftKey } from './session_store.js';
import { composeKey } from './session_store.js';
import {
    checkCompleted,
    draftEdited,
    failed,
    saveCompleted,
    type AnnotatorState,
} from './annotator_state.js';
import type { CheckResultByAnnotation } from '../types.js';

const ensureClient = (client: AnnotatorClient | null): AnnotatorClient => {
    if (!client) {
        throw new Error('annotator client unavailable');
    }
    return client;
};

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const runCheckLoop = async (
    state: AnnotatorState,
    client: AnnotatorClient | null,
): Promise<AnnotatorState> => {
    if (!state.canvasDraft) {
        return state;
    }
    try {
        const reply = await ensureClient(client).check({ canvasDraft: state.canvasDraft });
        return checkCompleted(state, { results: reply.results, stale: reply.stale });
    } catch (error) {
        return failed(state, `check failed: ${errorMessage(error)}`);
    }
};

export const buildSessionKey = (state: AnnotatorState): SessionDraftKey | null => {
    if (!state.pageIdentity) {
        return null;
    }
    return composeKey({
        workspaceName: state.pageIdentity.workspaceName,
        tabName: state.pageIdentity.tabName,
        pageIdentity: state.pageIdentity,
        profileName: state.profileName,
    });
};

export const runSaveLoop = async (
    state: AnnotatorState,
    client: AnnotatorClient | null,
    sessionStore?: SessionStore | null,
): Promise<AnnotatorState> => {
    if (!state.canvasDraft || !state.profileName) {
        return state;
    }
    try {
        const reply = await ensureClient(client).save({
            canvasDraft: state.canvasDraft,
            profileName: state.profileName,
            expectedRevision: state.artifactRevision,
        });
        const next = saveCompleted(state, reply.artifactRevision);
        const key = buildSessionKey(state);
        if (key && sessionStore) {
            await sessionStore.clearDraft(key);
        }
        return next;
    } catch (error) {
        return failed(state, `save failed: ${errorMessage(error)}`);
    }
};

export const runRecognizeLoop = async (
    state: AnnotatorState,
    client: AnnotatorClient | null,
): Promise<AnnotatorState> => {
    try {
        const reply = await ensureClient(client).recognize({ canvasDraft: state.canvasDraft });
        const profileName = state.profileName || defaultProfileName(state);
        const canvasDraft = {
            ...reply.canvasDraft,
            profileName,
            page: {
                ...reply.canvasDraft.page,
                ...(reply.canvasDraft.page.urlPattern ? {} : {urlPattern: pageUrlPattern(state)}),
            },
        };
        const next = draftEdited(state, canvasDraft);
        return {
            ...next,
            profileName,
            currentEntityId: next.currentEntityId ?? canvasDraft.entities[0]?.id ?? null,
        };
    } catch (error) {
        return failed(state, `recognize failed: ${errorMessage(error)}`);
    }
};

const defaultProfileName = (state: AnnotatorState): string => {
    const raw = state.pageIdentity?.url ?? 'page';
    try {
        const url = new URL(raw);
        const suffix = `${url.hostname}${url.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        return `page-${suffix || 'rule'}`;
    } catch {
        return 'page-rule';
    }
};

const pageUrlPattern = (state: AnnotatorState): string | undefined => {
    const raw = state.pageIdentity?.url;
    if (!raw) {return undefined;}
    try {
        const url = new URL(raw);
        return `^${`${url.origin}${url.pathname}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?#]|$)`;
    } catch {
        return undefined;
    }
};

export const restoreSessionDraft = async (
    state: AnnotatorState,
    sessionStore?: SessionStore | null,
): Promise<AnnotatorState> => {
    if (!sessionStore || !state.pageIdentity) {
        return state;
    }
    const key = buildSessionKey(state);
    if (!key) {
        return state;
    }
    let draft;
    try {
        draft = await sessionStore.loadDraft(key, state.pageIdentity);
    } catch {
        return state;
    }
    if (!draft) {
        return state;
    }
    return draftEdited(state, draft);
};

export const persistSessionDraft = async (
    state: AnnotatorState,
    sessionStore?: SessionStore | null,
): Promise<void> => {
    if (!sessionStore || !state.canvasDraft || !state.pageIdentity) {
        return;
    }
    const key = buildSessionKey(state);
    if (!key) {
        return;
    }
    try {
        await sessionStore.saveDraft(key, state.canvasDraft, state.pageIdentity);
    } catch {
        // session draft persistence is best-effort; ignore storage failures
    }
};

export const shouldEnterReselect = (
    annotationId: string,
    results: CheckResultByAnnotation[] | null,
): boolean => {
    if (!results) {
        return false;
    }
    const result = results.find((item) => item.canvasAnnotationId === annotationId);
    if (!result) {
        return false;
    }
    return result.status !== 'unique';
};

export const decideSelectAction = (
    annotationId: string,
    results: CheckResultByAnnotation[] | null,
): { reselect: boolean } => {
    if (annotationId.startsWith('entity:')) {
        return { reselect: false };
    }
    return { reselect: shouldEnterReselect(annotationId, results) };
};
