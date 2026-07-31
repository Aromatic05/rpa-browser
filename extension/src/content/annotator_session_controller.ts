import type {EntityRuleSelection} from '../../../shared/entity-rules-contract/index.js';

export type AnnotatorInteractionMode = 'edit' | 'inspect' | 'passthrough';
export type AnnotatorSessionOwner = 'editor' | 'rule-preview' | 'checkpoint-preview';

export type AnnotatorSessionHandle = {
    show: () => void;
    hide: () => void;
    open: (result: unknown) => void;
    exit: () => void;
    setInteractionMode: (mode: AnnotatorInteractionMode) => void;
};

export type AnnotatorOpenReply = {
    type: string;
    payload?: unknown;
};

export type CreateAnnotatorSessionControllerOptions = {
    ensureHandle: () => Promise<AnnotatorSessionHandle | null>;
    open: (payload: Record<string, unknown>) => Promise<AnnotatorOpenReply>;
    pageUrl: () => string;
    onEditorActiveChange?: (active: boolean) => void;
    onError?: (owner: AnnotatorSessionOwner, error: unknown) => void;
};

export type AnnotatorSessionController = {
    openEditor: (profileName?: string) => Promise<boolean>;
    previewRule: (selection: EntityRuleSelection | null) => Promise<boolean>;
    previewCheckpoint: (selection: EntityRuleSelection | null) => Promise<boolean>;
    close: (owner?: AnnotatorSessionOwner) => void;
    owner: () => AnnotatorSessionOwner | null;
};

export const createAnnotatorSessionController = (
    options: CreateAnnotatorSessionControllerOptions,
): AnnotatorSessionController => {
    let activeOwner: AnnotatorSessionOwner | null = null;
    let generation = 0;
    let currentHandle: AnnotatorSessionHandle | null = null;

    const close = (owner?: AnnotatorSessionOwner): void => {
        if (owner && activeOwner !== owner) {return;}
        generation += 1;
        const closingOwner = activeOwner;
        activeOwner = null;
        if (currentHandle) {
            currentHandle.setInteractionMode('edit');
            currentHandle.exit();
            currentHandle.hide();
        }
        if (closingOwner === 'editor') {
            options.onEditorActiveChange?.(false);
        }
    };

    const openSession = async (
        owner: AnnotatorSessionOwner,
        mode: AnnotatorInteractionMode,
        selection?: EntityRuleSelection,
        profileName?: string,
    ): Promise<boolean> => {
        const request = ++generation;
        const previousOwner = activeOwner;
        activeOwner = owner;
        if (previousOwner === 'editor' && owner !== 'editor') {
            options.onEditorActiveChange?.(false);
        }
        if (owner === 'editor') {
            options.onEditorActiveChange?.(true);
        }
        const handle = await options.ensureHandle();
        if (!handle || request !== generation || activeOwner !== owner) {return false;}
        currentHandle = handle;
        handle.exit();
        handle.setInteractionMode(mode);
        handle.show();
        try {
            const reply = await options.open({
                url: options.pageUrl(),
                ...(profileName ? {profileName} : {}),
                ...(selection ? {
                    profileName: selection.profileName,
                    businessTag: selection.businessTag,
                    entityKind: selection.entityKind,
                } : {}),
            });
            if (request !== generation || activeOwner !== owner) {return false;}
            if (reply.type.endsWith('.failed') || !isRecord(reply.payload)) {
                throw new Error(readFailureMessage(reply.payload));
            }
            handle.open(reply.payload);
            return true;
        } catch (error) {
            if (request !== generation || activeOwner !== owner) {return false;}
            options.onError?.(owner, error);
            close(owner);
            return false;
        }
    };

    const preview = async (
        owner: Extract<AnnotatorSessionOwner, 'rule-preview' | 'checkpoint-preview'>,
        mode: Extract<AnnotatorInteractionMode, 'inspect' | 'passthrough'>,
        selection: EntityRuleSelection | null,
    ): Promise<boolean> => {
        if (!selection) {
            close(owner);
            return true;
        }
        return await openSession(owner, mode, selection);
    };

    return {
        openEditor: async (profileName) => {
            return await openSession('editor', 'edit', undefined, profileName);
        },
        previewRule: async (selection) => {
            return await preview('rule-preview', 'inspect', selection);
        },
        previewCheckpoint: async (selection) => {
            return await preview('checkpoint-preview', 'passthrough', selection);
        },
        close,
        owner: () => activeOwner,
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const readFailureMessage = (payload: unknown): string => {
    if (!isRecord(payload)) {return '无法打开页面规则';}
    const message = typeof payload.message === 'string'
        ? payload.message
        : typeof payload.error === 'string'
            ? payload.error
            : '';
    return message || '无法打开页面规则';
};
