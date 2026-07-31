import type {
    CanvasDraft,
    CheckResultByAnnotation,
    VisualTargetRef,
    AnnotatorOpenResult,
    PageIdentity,
    AnnotatorProfileOption,
} from '../types.js';

export type AnnotatorMode = 'idle' | 'loading' | 'editing' | 'checking' | 'saving';

export type AnnotatorState = {
    mode: AnnotatorMode;
    canvasDraft: CanvasDraft | null;
    currentEntityId: string | null;
    currentAnnotationId: string | null;
    dirty: boolean;
    stale: boolean;
    artifactRevision: string | null;
    pageIdentity: PageIdentity | null;
    profileName: string | null;
    availableProfiles: AnnotatorProfileOption[];
    suggestedProfileName: string | null;
    history: { past: CanvasDraft[]; future: CanvasDraft[] };
    visualBindings: VisualTargetRef[];
    latestCheck: CheckResultByAnnotation[] | null;
    error: string | null;
};

export const initialState = (): AnnotatorState => ({
    mode: 'idle',
    canvasDraft: null,
    currentEntityId: null,
    currentAnnotationId: null,
    dirty: false,
    stale: false,
    artifactRevision: null,
    pageIdentity: null,
    profileName: null,
    availableProfiles: [],
    suggestedProfileName: null,
    history: { past: [], future: [] },
    visualBindings: [],
    latestCheck: null,
    error: null,
});

export const enterAnnotation = (state: AnnotatorState): AnnotatorState => ({
    ...state,
    mode: 'loading',
    error: null,
});

export const openLoaded = (state: AnnotatorState, result: AnnotatorOpenResult): AnnotatorState => ({
    ...state,
    mode: 'editing',
    canvasDraft: result.canvasDraft,
    currentEntityId: result.canvasDraft?.entities[0]?.id ?? null,
    currentAnnotationId: null,
    artifactRevision: result.artifactRevision,
    pageIdentity: { workspaceName: result.workspaceName, tabName: result.tabName, url: result.url },
    profileName: result.profileName,
    availableProfiles: result.availableProfiles ?? [],
    suggestedProfileName: result.suggestedProfileName ?? null,
    visualBindings: result.visualTargetRefs,
    dirty: false,
    stale: false,
    latestCheck: null,
    history: { past: [], future: [] },
    error: null,
});

export type PickSelection = {
    entityId?: string | null;
    annotationId?: string | null;
};

const selectedValue = <T>(
    selection: PickSelection,
    key: keyof PickSelection,
    current: T,
): T => Object.prototype.hasOwnProperty.call(selection, key)
    ? selection[key] as T
    : current;

export const pickReceived = (state: AnnotatorState, selection: PickSelection): AnnotatorState => ({
    ...state,
    mode: 'editing',
    currentEntityId: selectedValue(selection, 'entityId', state.currentEntityId),
    currentAnnotationId: selectedValue(selection, 'annotationId', state.currentAnnotationId),
    error: null,
});

export const draftEdited = (state: AnnotatorState, nextDraft: CanvasDraft): AnnotatorState => {
    const past = state.canvasDraft ? [...state.history.past, state.canvasDraft] : state.history.past;
    return {
        ...state,
        canvasDraft: nextDraft,
        dirty: true,
        latestCheck: null,
        history: { past, future: [] },
        error: null,
    };
};

export type CheckCompletedPayload = {
    results: CheckResultByAnnotation[];
    stale: boolean;
};

export const checkCompleted = (
    state: AnnotatorState,
    payload: CheckCompletedPayload,
): AnnotatorState => ({
    ...state,
    mode: 'editing',
    latestCheck: payload.results,
    stale: payload.stale,
    error: null,
});

export const saveCompleted = (state: AnnotatorState, newRevision: string): AnnotatorState => ({
    ...state,
    mode: 'editing',
    dirty: false,
    artifactRevision: newRevision,
    history: { past: [], future: [] },
    error: null,
});

export const failed = (state: AnnotatorState, error: string): AnnotatorState => ({
    ...state,
    mode: state.mode === 'loading' ? 'idle' : 'editing',
    error,
});

export const exitAnnotation = (state: AnnotatorState): AnnotatorState => ({
    ...state,
    mode: 'idle',
    currentEntityId: null,
    currentAnnotationId: null,
    latestCheck: null,
    error: null,
});

export const undo = (state: AnnotatorState): AnnotatorState => {
    if (state.history.past.length === 0) {return state;}
    const past = [...state.history.past];
    const previous = past.pop()!;
    const future = state.canvasDraft ? [state.canvasDraft, ...state.history.future] : state.history.future;
    return {
        ...state,
        canvasDraft: previous,
        dirty: true,
        latestCheck: null,
        history: { past, future },
    };
};

export const redo = (state: AnnotatorState): AnnotatorState => {
    if (state.history.future.length === 0) {return state;}
    const future = [...state.history.future];
    const next = future.shift()!;
    const past = state.canvasDraft ? [...state.history.past, state.canvasDraft] : state.history.past;
    return {
        ...state,
        canvasDraft: next,
        dirty: true,
        latestCheck: null,
        history: { past, future },
    };
};
