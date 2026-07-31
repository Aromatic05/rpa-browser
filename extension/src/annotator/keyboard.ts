export type KeyboardActionType =
    | 'cancel'
    | 'confirm'
    | 'delete'
    | 'save'
    | 'undo'
    | 'redo'
    | 'none';

export type KeyboardAction = { type: KeyboardActionType };

export type KeyboardTarget = { tagName?: string; isContentEditable?: boolean };

export type KeyboardEventLike = {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    target?: unknown;
};

export type KeyboardContext = {
    annotatorActive: boolean;
    inPickMode: boolean;
    hasSelection: boolean;
    canUndo: boolean;
    canRedo: boolean;
};

export const isTypingTarget = (target: unknown): boolean => {
    if (!target || typeof target !== 'object') {
        return false;
    }
    const record = target as { tagName?: unknown; isContentEditable?: unknown };
    const tag = typeof record.tagName === 'string' ? record.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
    if (record.isContentEditable === true) {
        return true;
    }
    return false;
};

export const resolveKeyboardAction = (
    event: KeyboardEventLike,
    ctx: KeyboardContext,
): KeyboardAction => {
    if (!ctx.annotatorActive) {
        return { type: 'none' };
    }
    if (event.key === 'Escape') {
        return { type: 'cancel' };
    }
    if (isTypingTarget(event.target ?? null)) {
        return { type: 'none' };
    }
    const ctrl = event.ctrlKey === true || event.metaKey === true;
    const key = event.key.toLowerCase();
    if (ctrl && event.shiftKey !== true && key === 's') {
        return { type: 'save' };
    }
    if (ctrl && event.shiftKey !== true && key === 'z') {
        return ctx.canUndo ? { type: 'undo' } : { type: 'none' };
    }
    if (ctrl && event.shiftKey === true && key === 'z') {
        return ctx.canRedo ? { type: 'redo' } : { type: 'none' };
    }
    if (event.key === 'Enter') {
        return ctx.inPickMode ? { type: 'confirm' } : { type: 'none' };
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
        return ctx.hasSelection ? { type: 'delete' } : { type: 'none' };
    }
    return { type: 'none' };
};
