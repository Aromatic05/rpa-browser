import type { Action } from '../shared/types.js';

export type PanelActionKind = 'control' | 'workspace';

export type PanelActionAddress = { workspaceName?: string };

export type PreparedPanelAction = {
    type: string;
    payload?: Record<string, unknown>;
    address?: PanelActionAddress;
};
const UUIDorUnsafe = (): string => {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    const now = Date.now().toString(16).padStart(12, '0');
    return `${rand()}-${rand().slice(0, 4)}-4${rand().slice(0, 3)}-a${rand().slice(0, 3)}-${now}${rand().slice(0, 4)}`.slice(0, 36);
};

const WORKSPACE_REQUIRED_PREFIXES = [
    'tab.',
    'record.',
    'play.',
    'dsl.',
    'checkpoint.',
    'entity_rules.',
    'task.run.',
];

const CONTROL_ACTIONS = new Set([
    'workspace.list',
    'workspace.create',
    'workspace.setActive',
    'workflow.list',
    'workflow.create',
    'workflow.open',
    'workflow.resetDefault',
]);

export const classifyPanelAction = (type: string): PanelActionKind => {
    if (CONTROL_ACTIONS.has(type)) {return 'control';}
    if (type === 'workflow.saveAs') {return 'control';}
    if (WORKSPACE_REQUIRED_PREFIXES.some((prefix) => type.startsWith(prefix))) {return 'workspace';}
    return 'control';
};

export const preparePanelAction = (
    type: string,
    payload: Record<string, unknown> | undefined,
    selectedWorkspaceName: string | null,
): PreparedPanelAction | { error: Action } => {
    const kind = classifyPanelAction(type);
    if (kind === 'workspace') {
        if (!selectedWorkspaceName) {
            return {
                error: {
                    v: 1,
                    id: UUIDorUnsafe(),
                    type: `${type}.failed`,
                    payload: { code: 'ERR_BAD_ARGS', message: 'workspaceName is required' },
                },
            };
        }
        return {
            type,
            payload,
            address: { workspaceName: selectedWorkspaceName },
        };
    }
    return { type, payload };
};

export type PanelLogKind = 'request' | 'reply' | 'failed' | 'event';

export type PanelLogEntry = {
    at: number;
    kind: PanelLogKind;
    action: Action;
};

export const pushPanelLog = (logs: PanelLogEntry[], entry: PanelLogEntry): PanelLogEntry[] => {
    const next = [...logs, entry];
    if (next.length <= 50) {return next;}
    return next.slice(next.length - 50);
};
