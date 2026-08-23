import type {
    AnnotatorApplyPayload,
    AnnotatorClient,
    AnnotatorDraft,
    AnnotatorOverlayPort,
    AnnotatorPoint,
    AnnotatorProjectionReply,
    AnnotatorSession,
    AnnotatorSessionState,
} from './contracts.js';

export type CreateAnnotatorSessionInput = {
    client: AnnotatorClient;
    overlay: AnnotatorOverlayPort;
    onChange?: (state: AnnotatorSessionState) => void;
};

export const createAnnotatorSession = (input: CreateAnnotatorSessionInput): AnnotatorSession => {
    let state: AnnotatorSessionState = {status: 'idle', profileName: ''};
    let artifactRevisionProfileName: string | undefined;
    const listeners = new Set<(state: AnnotatorSessionState) => void>();

    const publish = (patch: Partial<AnnotatorSessionState>): void => {
        state = {...state, ...patch};
        const snapshot = structuredClone(state);
        input.onChange?.(snapshot);
        listeners.forEach((listener) => {
            listener(structuredClone(snapshot));
        });
    };

    const applyProjection = (reply: AnnotatorProjectionReply): void => {
        input.overlay.render(reply.projection);
        const profileDraft = draftFromProfile(reply.profile);
        const profileName = profileDraft?.profileName ?? state.profileName;
        const artifactRevision = reply.artifactRevision === undefined
            ? artifactRevisionProfileName === profileName ? state.artifactRevision : undefined
            : reply.artifactRevision;
        artifactRevisionProfileName = artifactRevision === undefined ? undefined : profileName;
        publish({
            status: 'ready',
            projection: structuredClone(reply.projection),
            validation: reply.validation ? structuredClone(reply.validation) : state.validation,
            draft: profileDraft ?? state.draft,
            profileName,
            artifactRevision,
            error: undefined,
        });
    };

    const runProjection = async (
        status: AnnotatorSessionState['status'],
        operation: () => Promise<AnnotatorProjectionReply>,
    ): Promise<void> => {
        publish({status, error: undefined});
        try {
            applyProjection(await operation());
        } catch (error) {
            publish({status: 'error', error: errorMessage(error)});
            throw error;
        }
    };

    const open = async (profileName?: string): Promise<void> => {
        const normalized = profileName?.trim() ?? '';
        artifactRevisionProfileName = undefined;
        publish({profileName: normalized, artifactRevision: undefined});
        await runProjection('loading', async () => await input.client.open(normalized || undefined));
    };

    const recognize = async (): Promise<void> => {
        await runProjection(
            'loading',
            async () => await input.client.recognize(state.profileName || undefined),
        );
    };

    const visualize = async (): Promise<void> => {
        await runProjection(
            'loading',
            async () => await input.client.visualize(state.profileName || undefined),
        );
    };

    const pick = async (point: AnnotatorPoint): Promise<void> => {
        publish({status: 'loading', error: undefined});
        try {
            const reply = await input.client.pick(point);
            input.overlay.render(reply.projection);
            publish({status: 'ready', projection: structuredClone(reply.projection)});
        } catch (error) {
            publish({status: 'error', error: errorMessage(error)});
            throw error;
        }
    };

    const apply = async (payload: AnnotatorApplyPayload): Promise<void> => {
        const artifactRevision = artifactRevisionProfileName === payload.draft.profileName
            ? state.artifactRevision
            : undefined;
        artifactRevisionProfileName = artifactRevision === undefined ? undefined : payload.draft.profileName;
        publish({
            status: 'applying',
            draft: structuredClone(payload.draft),
            profileName: payload.draft.profileName,
            validation: undefined,
            artifactRevision,
            error: undefined,
        });
        try {
            const reply = await input.client.apply(payload);
            input.overlay.render(reply.projection);
            publish({
                status: 'ready',
                profileName: reply.draft.profileName,
                draft: structuredClone(reply.draft),
                projection: structuredClone(reply.projection),
                validation: structuredClone(reply.validation),
            });
        } catch (error) {
            publish({status: 'error', error: errorMessage(error)});
            throw error;
        }
    };

    const check = async (draft = requireDraft(state.draft)): Promise<void> => {
        publish({status: 'checking', draft: structuredClone(draft), error: undefined});
        try {
            const reply = await input.client.check(draft);
            input.overlay.render(reply.projection);
            publish({
                status: 'ready',
                projection: structuredClone(reply.projection),
                validation: structuredClone(reply.validation),
            });
        } catch (error) {
            publish({status: 'error', error: errorMessage(error)});
            throw error;
        }
    };

    const save = async (draft = requireDraft(state.draft)): Promise<void> => {
        const expectedRevision = artifactRevisionProfileName === draft.profileName
            ? state.artifactRevision ?? null
            : null;
        artifactRevisionProfileName = draft.profileName === state.profileName
            ? artifactRevisionProfileName
            : undefined;
        publish({
            status: 'saving',
            draft: structuredClone(draft),
            profileName: draft.profileName,
            artifactRevision: expectedRevision,
            error: undefined,
        });
        try {
            const reply = await input.client.save(draft, expectedRevision);
            input.overlay.render(reply.projection);
            artifactRevisionProfileName = draft.profileName;
            publish({
                status: 'ready',
                projection: structuredClone(reply.projection),
                validation: structuredClone(reply.validation),
                artifactRevision: reply.artifactRevision,
            });
        } catch (error) {
            publish({status: 'error', error: errorMessage(error)});
            throw error;
        }
    };

    return {
        getState: (): AnnotatorSessionState => structuredClone(state),
        setDraft: (draft: AnnotatorDraft): void => {
            const artifactRevision = artifactRevisionProfileName === draft.profileName
                ? state.artifactRevision
                : undefined;
            artifactRevisionProfileName = artifactRevision === undefined ? undefined : draft.profileName;
            publish({
                draft: structuredClone(draft),
                profileName: draft.profileName,
                validation: undefined,
                artifactRevision,
            });
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        open,
        recognize,
        visualize,
        pick,
        apply,
        check,
        save,
        startPicking: input.overlay.startPicking,
        stopPicking: input.overlay.stopPicking,
        dispose: () => {
            listeners.clear();
            input.overlay.dispose();
        },
    };
};

const requireDraft = (draft: AnnotatorDraft | undefined): AnnotatorDraft => {
    if (!draft) {throw new Error('annotator draft is required');}
    return draft;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);


const draftFromProfile = (value: unknown): AnnotatorDraft | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return undefined;}
    const profile = value as Record<string, unknown>;
    if (profile.kind !== 'entity_rules' || typeof profile.name !== 'string' || !profile.name.trim()) {
        return undefined;
    }
    if (!profile.match || typeof profile.match !== 'object' || Array.isArray(profile.match)) {return undefined;}
    if (!profile.annotation || typeof profile.annotation !== 'object' || Array.isArray(profile.annotation)) {
        return undefined;
    }
    const match = profile.match as Record<string, unknown>;
    const annotation = profile.annotation as Record<string, unknown>;
    if (match.version !== 2 || !Array.isArray(match.rules)
        || annotation.version !== 2 || !Array.isArray(annotation.bindings)) {
        return undefined;
    }
    return {
        profileName: profile.name.trim(),
        page: profile.page === undefined
            ? undefined
            : structuredClone(profile.page) as AnnotatorDraft['page'],
        match: structuredClone(match) as AnnotatorDraft['match'],
        annotation: structuredClone(annotation) as AnnotatorDraft['annotation'],
    };
};
