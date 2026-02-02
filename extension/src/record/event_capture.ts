/**
 * event_capture：捕获 click/input/change/keydown/navigation 并生成原始事件。
 *
 * 注意：
 * - 只捕获顶层文档
 * - 不做持久化，交由 recorder/record_store 处理
 */

import type { TargetDescriptor } from './target_descriptor.js';
import { describeTarget } from './target_descriptor.js';

export type RawEvent =
    | { type: 'click'; ts: number; url: string; target: TargetDescriptor }
    | { type: 'input'; ts: number; url: string; target: TargetDescriptor; value: string }
    | { type: 'change'; ts: number; url: string; target: TargetDescriptor; value: string }
    | {
          type: 'keydown';
          ts: number;
          url: string;
          target: TargetDescriptor;
          key: { code: string; key: string; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
      }
    | { type: 'navigate'; ts: number; url: string };

export type CaptureOptions = {
    onEvent: (event: RawEvent) => void;
};

export const installCapture = (opts: CaptureOptions) => {
    const handleClick = (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        opts.onEvent({ type: 'click', ts: Date.now(), url: location.href, target: describeTarget(target) });
    };

    const handleInput = (event: Event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        opts.onEvent({
            type: 'input',
            ts: Date.now(),
            url: location.href,
            target: describeTarget(target),
            value: target.value,
        });
    };

    const handleChange = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target instanceof HTMLSelectElement) {
            opts.onEvent({
                type: 'change',
                ts: Date.now(),
                url: location.href,
                target: describeTarget(target),
                value: target.value,
            });
            return;
        }
        if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
            opts.onEvent({
                type: 'change',
                ts: Date.now(),
                url: location.href,
                target: describeTarget(target),
                value: target.checked ? 'true' : 'false',
            });
        }
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

    const handleNavigate = () => {
        opts.onEvent({ type: 'navigate', ts: Date.now(), url: location.href });
    };

    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('keydown', handleKeydown, true);
    window.addEventListener('popstate', handleNavigate);
    window.addEventListener('hashchange', handleNavigate);

    return () => {
        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('input', handleInput, true);
        document.removeEventListener('change', handleChange, true);
        document.removeEventListener('keydown', handleKeydown, true);
        window.removeEventListener('popstate', handleNavigate);
        window.removeEventListener('hashchange', handleNavigate);
    };
};
