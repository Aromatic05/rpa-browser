/**
 * event_capture：捕获 click/input/scroll/navigation 并生成原始事件。
 *
 * 注意：
 * - 只捕获顶层文档
 * - 不做持久化，交由 recorder/background 处理
 * - RawEvent 必须可序列化，禁止包含 Element 引用
 */

import { describeTarget, type TargetDescriptor } from './target_descriptor.js';

export type RawEvent =
    | { type: 'click'; ts: number; url: string; target: TargetDescriptor }
    | { type: 'input'; ts: number; url: string; target: TargetDescriptor; value: string }
    | { type: 'change'; ts: number; url: string; target: TargetDescriptor; value: string; selectedText?: string }
    | { type: 'keydown'; ts: number; url: string; target: TargetDescriptor; key: { code: string; key: string; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean } }
    | { type: 'scroll'; ts: number; url: string; target: TargetDescriptor; scroll: { x: number; y: number } }
    | { type: 'navigate'; ts: number; url: string };

export type CaptureOptions = {
    onEvent: (event: RawEvent) => void;
};

const pickScrollTarget = (evtTarget: EventTarget | null) => {
    if (evtTarget instanceof Element) return evtTarget;
    return document.documentElement || document.body || document;
};

export const installCapture = (opts: CaptureOptions) => {
    let composing = false;
    let scrollTimer: number | null = null;
    let pendingScrollTarget: EventTarget | null = null;
    let pendingScrollX = 0;
    let pendingScrollY = 0;

    const emitScroll = () => {
        scrollTimer = null;
        const target = pickScrollTarget(pendingScrollTarget);
        opts.onEvent({
            type: 'scroll',
            ts: Date.now(),
            url: location.href,
            target: describeTarget(target),
            scroll: { x: pendingScrollX, y: pendingScrollY },
        });
    };

    const handleClick = (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        opts.onEvent({
            type: 'click',
            ts: Date.now(),
            url: location.href,
            target: describeTarget(target),
        });
    };

    const handleInput = (event: Event) => {
        if (composing) return;
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        opts.onEvent({
            type: 'input',
            ts: Date.now(),
            url: location.href,
            target: describeTarget(target, { includeInputValue: true }),
            value: target.value,
        });
    };

    const handleCompositionStart = () => {
        composing = true;
    };

    const handleCompositionEnd = (event: CompositionEvent) => {
        composing = false;
        // 中文输入法结束后补发一次 input，避免中间态多次触发。
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        opts.onEvent({
            type: 'input',
            ts: Date.now(),
            url: location.href,
            target: describeTarget(target, { includeInputValue: true }),
            value: target.value,
        });
    };

    const handleChange = (event: Event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
        const base: RawEvent = {
            type: 'change',
            ts: Date.now(),
            url: location.href,
            target: describeTarget(target, { includeInputValue: true }),
            value: '',
        };
        if (target instanceof HTMLSelectElement) {
            const selected = target.selectedOptions?.[0]?.text || '';
            base.value = target.value;
            base.selectedText = selected ? selected.slice(0, 80) : undefined;
        } else if (target.type === 'checkbox' || target.type === 'radio') {
            base.value = target.checked ? 'true' : 'false';
        } else {
            base.value = target.value;
        }
        opts.onEvent(base);
    };

    const handleKeydown = (event: KeyboardEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        opts.onEvent({
            type: 'keydown',
            ts: Date.now(),
            url: location.href,
            target: describeTarget(target),
            key: {
                code: event.code,
                key: event.key,
                alt: event.altKey,
                ctrl: event.ctrlKey,
                meta: event.metaKey,
                shift: event.shiftKey,
            },
        });
    };

    const handleScroll = (event: Event) => {
        pendingScrollTarget = event.target;
        pendingScrollX = window.scrollX;
        pendingScrollY = window.scrollY;
        if (scrollTimer != null) return;
        scrollTimer = window.setTimeout(emitScroll, 200);
    };

    const handleNavigate = () => {
        opts.onEvent({ type: 'navigate', ts: Date.now(), url: location.href });
    };

    const wrapHistory = (method: typeof history.pushState) =>
        function (...args: Parameters<typeof history.pushState>) {
            const result = method.apply(history, args as unknown as [any, any, any]);
            handleNavigate();
            return result;
        };

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = wrapHistory(history.pushState);
    history.replaceState = wrapHistory(history.replaceState);

    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('compositionstart', handleCompositionStart, true);
    document.addEventListener('compositionend', handleCompositionEnd, true);
    document.addEventListener('keydown', handleKeydown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('popstate', handleNavigate);
    window.addEventListener('hashchange', handleNavigate);

    return () => {
        history.pushState = originalPushState;
        history.replaceState = originalReplaceState;
        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('input', handleInput, true);
        document.removeEventListener('change', handleChange, true);
        document.removeEventListener('compositionstart', handleCompositionStart, true);
        document.removeEventListener('compositionend', handleCompositionEnd, true);
        document.removeEventListener('keydown', handleKeydown, true);
        window.removeEventListener('scroll', handleScroll, true);
        window.removeEventListener('popstate', handleNavigate);
        window.removeEventListener('hashchange', handleNavigate);
    };
};
