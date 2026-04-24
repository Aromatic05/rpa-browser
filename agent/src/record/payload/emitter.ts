import { getLabelText, normalizeText } from './utils';

const getElementText = (el: Element) => {
    if ('innerText' in el) {return (el as HTMLElement).innerText || el.textContent || '';}
    return el.textContent || '';
};

export type EmitPayload = { type: string; [key: string]: any };
export type EmitFn = (payload: EmitPayload) => void;
export type DebugTargetFn = (label: string, target: Element | null, reason: string) => void;

const tokenKey = '__rpa_tab_token';

const getToken = () => {
    try {
        const fromSession = sessionStorage.getItem(tokenKey);
        if (fromSession) {return fromSession;}
    } catch {
        // ignore sessionStorage read failures
    }
    try {
        const fromWindow = (window as any).__rpa_tab_token || (window as any).__TAB_TOKEN__;
        if (fromWindow) {return fromWindow;}
    } catch {
        // ignore window token read failures
    }
    return null;
};

export const createEmitter = (bindingName: string, version: string) => {
    const emit: EmitFn = (payload) => {
        const tabToken = getToken();
        if (!tabToken) {
            try {
                console.warn('[recorder] missing tabToken', { url: location.href, payload: payload && payload.type });
            } catch {
                // ignore debug logging failures
            }
            return;
        }
        const bridge = (window as any)[bindingName];
        if (!bridge) {return;}
        bridge({
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
                tag: target && (target).tagName ? (target).tagName.toLowerCase() : undefined,
                id: target && (target).getAttribute ? (target).getAttribute('id') : undefined,
                className: target && (target).className ? String((target).className) : undefined,
                role: target && (target).getAttribute ? (target).getAttribute('role') : undefined,
                name: target ? getLabelText(target) || normalizeText(getElementText(target)) : undefined,
            };
            console.warn('[recorder] click capture skipped', info);
        } catch {
            // ignore debug logging failures
        }
    };

    return { emit, debugTarget };
};
