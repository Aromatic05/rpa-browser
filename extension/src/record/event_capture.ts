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

export const installCapture = (opts: CaptureOptions) => {
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

    const handleNavigate = () => {
        opts.onEvent({ type: 'navigate', ts: Date.now(), url: location.href });
    };

    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    window.addEventListener('popstate', handleNavigate);
    window.addEventListener('hashchange', handleNavigate);

    return () => {
        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('input', handleInput, true);
        window.removeEventListener('popstate', handleNavigate);
        window.removeEventListener('hashchange', handleNavigate);
    };
};
