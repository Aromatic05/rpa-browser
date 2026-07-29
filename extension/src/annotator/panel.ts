import type {AnnotatorDraft, AnnotatorSessionState} from './contracts.js';
import type {AnnotatorSession} from './contracts.js';

export type CreateAnnotatorPanelInput = {
    document: Document;
    session: AnnotatorSession;
};

export const createAnnotatorPanel = (input: CreateAnnotatorPanelInput): HTMLElement => {
    const state = input.session.getState();
    const root = input.document.createElement('div');
    root.setAttribute('data-rpa-annotator-panel', 'true');

    const profile = input.document.createElement('input');
    profile.placeholder = 'entity_rules profile';
    profile.value = state.profileName;

    const draft = input.document.createElement('textarea');
    draft.setAttribute('aria-label', 'entity_rules draft');
    draft.value = JSON.stringify(state.draft ?? emptyDraft(state.profileName), null, 2);
    draft.style.minHeight = '180px';

    const summary = input.document.createElement('div');
    summary.className = 'hint';
    summary.textContent = stateSummary(state);

    const actions = input.document.createElement('div');
    actions.className = 'row3';
    actions.append(
        button(input.document, 'Open', async () => {
            await input.session.open(profile.value.trim() || undefined);
        }, true),
        button(input.document, 'Pick', () => {
            input.session.startPicking();
        }),
        button(input.document, 'Recognize', async () => {
            await input.session.recognize();
        }),
        button(input.document, 'Visualize', async () => {
            await input.session.visualize();
        }),
        button(input.document, 'Check', async () => {
            const value = parseDraft(draft.value, profile.value);
            input.session.setDraft(value);
            await input.session.check();
        }),
        button(input.document, 'Save', async () => {
            const value = parseDraft(draft.value, profile.value);
            input.session.setDraft(value);
            await input.session.save();
        }, true),
    );

    root.append(profile, actions, draft, summary);
    return root;
};

const button = (
    document: Document,
    label: string,
    action: () => void | Promise<void>,
    primary = false,
): HTMLButtonElement => {
    const element = document.createElement('button');
    element.textContent = label;
    if (primary) {element.classList.add('primary');}
    element.addEventListener('click', () => {
        void Promise.resolve(action()).catch((error: unknown) => {
            element.setAttribute('data-error', error instanceof Error ? error.message : String(error));
        });
    });
    return element;
};

const parseDraft = (raw: string, profileName: string): AnnotatorDraft => {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('annotator draft must be an object');
    }
    const record = value as Record<string, unknown>;
    const normalizedProfileName = typeof record.profileName === 'string' && record.profileName.trim()
        ? record.profileName.trim()
        : profileName.trim();
    if (!normalizedProfileName) {throw new Error('annotator profileName is required');}
    if (!isArtifactPart(record.match, 'rules') || !isArtifactPart(record.annotation, 'bindings')) {
        throw new Error('annotator draft must contain V2 match.rules and annotation.bindings');
    }
    return {
        profileName: normalizedProfileName,
        page: record.page === undefined
            ? undefined
            : structuredClone(record.page) as AnnotatorDraft['page'],
        match: structuredClone(record.match) as AnnotatorDraft['match'],
        annotation: structuredClone(record.annotation) as AnnotatorDraft['annotation'],
    };
};

const isArtifactPart = (value: unknown, collection: 'rules' | 'bindings'): boolean =>
    Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).version === 2
    && Array.isArray((value as Record<string, unknown>)[collection]);

const emptyDraft = (profileName: string): AnnotatorDraft => ({
    profileName,
    match: {version: 2, rules: []},
    annotation: {version: 2, bindings: []},
});

const stateSummary = (state: AnnotatorSessionState): string => {
    const identity = state.projection?.identity;
    const selection = state.projection?.selection.status ?? 'none';
    const validation = state.validation ? ` validation=${state.validation.ok ? 'ok' : 'invalid'}` : '';
    const error = state.error ? ` error=${state.error}` : '';
    return `status=${state.status} epoch=${identity?.pageEpoch ?? '-'} revision=${identity ? String(identity.captureRevision) : '-'} selection=${selection}${validation}${error}`;
};
