import { getLabelText, normalizeText } from './utils';

const getElementText = (el: Element) => {
    if ('innerText' in el) return (el as HTMLElement).innerText || el.textContent || '';
    return el.textContent || '';
};

export type EmitPayload = { type: string; [key: string]: any };
export type EmitFn = (payload: EmitPayload) => void;
export type DebugTargetFn = (label: string, target: Element | null, reason: string) => void;

const tokenKey = '__rpa_tab_token';

const getToken = () => {
    try {
        const fromSession = sessionStorage.getItem(tokenKey);
        if (fromSession) return fromSession;
    } catch {}
    try {
        const fromWindow = (window as any).__rpa_tab_token || (window as any).__TAB_TOKEN__;
        if (fromWindow) return fromWindow;
    } catch {}
    try {
        if (window.top && window.top !== window) {
            const fromTop = window.top.sessionStorage && window.top.sessionStorage.getItem(tokenKey);
            if (fromTop) return fromTop;
            const fromTopWin = (window.top as any).__rpa_tab_token || (window.top as any).__TAB_TOKEN__;
            if (fromTopWin) return fromTopWin;
        }
    } catch {}
    try {
        if (window.parent && window.parent !== window) {
            const fromParent = window.parent.sessionStorage && window.parent.sessionStorage.getItem(tokenKey);
            if (fromParent) return fromParent;
            const fromParentWin = (window.parent as any).__rpa_tab_token || (window.parent as any).__TAB_TOKEN__;
            if (fromParentWin) return fromParentWin;
        }
    } catch {}
    return null;
};

export const createEmitter = (bindingName: string) => {
    const emit: EmitFn = (payload) => {
        const tabToken = getToken();
        if (!tabToken) {
            try {
                console.warn('[recorder] missing tabToken', { url: location.href, payload: payload && payload.type });
            } catch {}
            return;
        }
        const bridge = (window as any)[bindingName];
        if (!bridge) return;
        bridge({
            tabToken,
            ts: Date.now(),
            url: location.href,
            ...payload,
        });
    };

    const debugTarget: DebugTargetFn = (label, target, reason) => {
        try {
            const info = {
                label,
                reason,
                url: location.href,
                tag: target && (target as Element).tagName ? (target as Element).tagName.toLowerCase() : undefined,
                id: target && (target as Element).getAttribute ? (target as Element).getAttribute('id') : undefined,
                className: target && (target as Element).className ? String((target as Element).className) : undefined,
                role: target && (target as Element).getAttribute ? (target as Element).getAttribute('role') : undefined,
                name: target ? getLabelText(target) || normalizeText(getElementText(target)) : undefined,
            };
            console.warn('[recorder] click capture skipped', info);
        } catch {}
    };

    return { emit, debugTarget };
};
