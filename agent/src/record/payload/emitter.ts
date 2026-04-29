import { getLabelText, normalizeText } from './utils';

const getElementText = (el: Element) => {
    if ('innerText' in el) {return (el as HTMLElement).innerText || el.textContent || '';}
    return el.textContent || '';
};

type WindowWithTabToken = Window & { __rpa_tab_token?: unknown; __TAB_TOKEN__?: unknown };
type WindowBridge = Window & Record<string, unknown>;
type RecorderControlWindow = Window & { __rpa_recorder_enabled?: unknown };

export type EmitPayload = { type: string; [key: string]: unknown };
export type EmitFn = (payload: EmitPayload) => void;
export type DebugTargetFn = (label: string, target: Element | null, reason: string) => void;

const tokenKey = '__rpa_tab_token';

const getToken = (): string | null => {
    try {
        const fromSession = sessionStorage.getItem(tokenKey);
        if (fromSession) {return fromSession;}
    } catch {
        // ignore sessionStorage read failures
    }
    try {
        const fromWindow = (window as WindowWithTabToken).__rpa_tab_token ?? (window as WindowWithTabToken).__TAB_TOKEN__;
        if (typeof fromWindow === 'string' && fromWindow.length > 0) {return fromWindow;}
    } catch {
        // ignore window token read failures
    }
    return null;
};

export const createEmitter = (bindingName: string, version: string): { emit: EmitFn; debugTarget: DebugTargetFn } => {
    const emit: EmitFn = (payload) => {
        const enabled = (window as RecorderControlWindow).__rpa_recorder_enabled;
        if (enabled === false) {return;}
        const tabToken = getToken();
        if (!tabToken) {
            try {
                console.warn('[recorder] missing tabToken', { url: location.href, payload: payload.type });
            } catch {
                // ignore debug logging failures
            }
            return;
        }
        const bridge = (window as WindowBridge)[bindingName];
        if (typeof bridge !== 'function') {return;}
        const bridgeFn = bridge as (payload: Record<string, unknown>) => void;
        bridgeFn({
            recorderVersion: version,
            tabToken,
            ts: Date.now(),
            url: location.href,
            pageTitle: document.title,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
            },
            ...payload,
        });
    };

    const debugTarget: DebugTargetFn = (label, target, reason) => {
        try {
            const info = {
                label,
                reason,
                url: location.href,
                tag: target?.tagName.toLowerCase(),
                id: target?.getAttribute('id'),
                className: target?.className,
                role: target?.getAttribute('role'),
                name: target ? getLabelText(target) || normalizeText(getElementText(target)) : undefined,
            };
            console.warn('[recorder] click capture skipped', info);
        } catch {
            // ignore debug logging failures
        }
    };

    return { emit, debugTarget };
};
