/**
 * event_capture：捕获 click/input/scroll/navigation 并生成原始事件。
 *
 * 注意：
 * - 只捕获顶层文档
 * - 不做持久化，交由 recorder/record_store 处理
 */

export type RawEvent =
    | { type: 'click'; target: Element }
    | { type: 'input'; target: Element; value: string }
    | { type: 'navigate'; url: string };

export type CaptureOptions = {
    onEvent: (event: RawEvent) => void;
};

export const installCapture = (opts: CaptureOptions) => {
    const handleClick = (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        opts.onEvent({ type: 'click', target });
    };

    const handleInput = (event: Event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        opts.onEvent({ type: 'input', target, value: target.value });
    };

    const handleNavigate = () => {
        opts.onEvent({ type: 'navigate', url: location.href });
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
