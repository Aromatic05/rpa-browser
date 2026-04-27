import type { DebugTargetFn, EmitFn } from './emitter';
import {
    buildA11yHint,
    buildCandidates,
    findCheckboxInput,
    getScopeHint,
    getValue,
    isCheckboxOrRadio,
    isPassword,
    selectorFor,
} from './utils';

const specialKeys = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const handledEvents = new WeakSet<Event>();

const markEventHandled = (event: Event) => {
    if (handledEvents.has(event)) {return true;}
    handledEvents.add(event);
    return false;
};

const inPanel = (path: EventTarget[] | null) => {
    if (!path) {return false;}
    for (const node of path) {
        if (node instanceof HTMLElement && node.id === 'rpa-floating-panel') {return true;}
    }
    return false;
};

export const installHandlers = (emit: EmitFn, debugTarget: DebugTargetFn): void => {
    const handleClick = (event: MouseEvent) => {
        if (markEventHandled(event)) {return;}
        const path = event.composedPath();
        let target = path[0] || event.target;
        if (target instanceof Node && target.nodeType === 3) {target = target.parentElement;}
        const element = target instanceof Element ? target : null;
        if (!element) {return;}
        if (inPanel(path) || element.closest('#rpa-floating-panel')) {return;}
        if (isCheckboxOrRadio(element) || element.closest('label input[type="checkbox"], label input[type="radio"]')) {return;}
        const checkboxInput = findCheckboxInput(element);
        if (checkboxInput) {return;}
        const interactive = element.closest('button, a, input, select, textarea, [role]') || element;
        const selector = selectorFor(interactive);
        if (selector) {
            emit({
                type: 'click',
                selector,
                targetHint: interactive.tagName.toLowerCase(),
                a11yHint: buildA11yHint(interactive),
                locatorCandidates: buildCandidates(interactive),
                scopeHint: getScopeHint(interactive),
            });
            return;
        }
        const fallback = interactive.closest('button, a, input, select, textarea, [role]');
        if (!fallback) {
            debugTarget('click', interactive, 'no selector and no fallback');
            return;
        }
        const fallbackSelector = selectorFor(fallback);
        if (fallbackSelector) {
            emit({
                type: 'click',
                selector: fallbackSelector,
                targetHint: fallback.tagName.toLowerCase(),
                a11yHint: buildA11yHint(fallback),
                locatorCandidates: buildCandidates(fallback),
                scopeHint: getScopeHint(fallback),
            });
            return;
        }
        const hintOnly = buildA11yHint(fallback);
        if (hintOnly.role || hintOnly.name || hintOnly.text) {
            emit({
                type: 'click',
                targetHint: fallback.tagName.toLowerCase(),
                a11yHint: hintOnly,
                locatorCandidates: buildCandidates(fallback),
                scopeHint: getScopeHint(fallback),
            });
            return;
        }
        debugTarget('click', fallback, 'fallback selector missing');
    };

    document.addEventListener('click', handleClick, true);

    document.addEventListener(
        'input',
        (event) => {
            const target = event.composedPath()[0] || event.target;
            const element = target instanceof Element ? target : null;
            if (!element) {return;}
            if (element.closest('#rpa-floating-panel')) {return;}
            if (isCheckboxOrRadio(element)) {return;}
            if (element instanceof HTMLSelectElement) {return;}
            const selector = selectorFor(element);
            if (!selector) {return;}
            emit({
                type: 'input',
                selector,
                value: getValue(element),
                a11yHint: buildA11yHint(element),
                locatorCandidates: buildCandidates(element),
                scopeHint: getScopeHint(element),
            });
        },
        true,
    );

    document.addEventListener(
        'change',
        (event) => {
            const target = event.composedPath()[0] || event.target;
            const element = target instanceof Element ? target : null;
            if (!element) {return;}
            if (element.closest('#rpa-floating-panel')) {return;}
            const selector = selectorFor(element);
            if (!selector) {return;}
            if (element instanceof HTMLInputElement) {
                const inputType = (element.type || '').toLowerCase();
                if (inputType === 'checkbox' || inputType === 'radio') {
                    emit({
                        type: 'check',
                        selector,
                        checked: element.checked,
                        inputType,
                        a11yHint: buildA11yHint(element),
                        locatorCandidates: buildCandidates(element),
                        scopeHint: getScopeHint(element),
                    });
                    return;
                }
                if (inputType === 'date') {
                    emit({
                        type: 'date',
                        selector,
                        value: element.value,
                        a11yHint: buildA11yHint(element),
                        locatorCandidates: buildCandidates(element),
                        scopeHint: getScopeHint(element),
                    });
                    return;
                }
            }
            if (element instanceof HTMLSelectElement) {
                const option = element.selectedOptions[0];
                emit({
                    type: 'select',
                    selector,
                    value: element.value,
                    label: option.label,
                    a11yHint: buildA11yHint(element),
                    locatorCandidates: buildCandidates(element),
                    scopeHint: getScopeHint(element),
                });
                return;
            }
            emit({
                type: 'change',
                selector,
                value: getValue(element),
                a11yHint: buildA11yHint(element),
                locatorCandidates: buildCandidates(element),
                scopeHint: getScopeHint(element),
            });
        },
        true,
    );

    document.addEventListener(
        'keydown',
        (event: KeyboardEvent) => {
            if (!specialKeys.has(event.key)) {return;}
            const target = event.composedPath()[0] || event.target;
            const element = target instanceof Element ? target : null;
            if (element?.closest('#rpa-floating-panel')) {return;}
            const selector = element instanceof Element ? selectorFor(element) : null;
            emit({
                type: 'keydown',
                selector,
                key: event.key,
                a11yHint: element instanceof Element ? buildA11yHint(element) : undefined,
                locatorCandidates: element instanceof Element ? buildCandidates(element) : undefined,
                scopeHint: element instanceof Element ? getScopeHint(element) : undefined,
            });
        },
        true,
    );

    document.addEventListener(
        'paste',
        (event) => {
            const target = event.composedPath()[0] || event.target;
            const element = target instanceof Element ? target : null;
            if (!element) {return;}
            if (element.closest('#rpa-floating-panel')) {return;}
            const selector = selectorFor(element);
            if (!selector) {return;}
            if (isPassword(element)) {return;}
            emit({
                type: 'paste',
                selector,
                value: getValue(element),
                a11yHint: buildA11yHint(element),
                locatorCandidates: buildCandidates(element),
                scopeHint: getScopeHint(element),
            });
        },
        true,
    );

    document.addEventListener(
        'copy',
        (event) => {
            const target = event.composedPath()[0] || event.target;
            const element = target instanceof Element ? target : null;
            if (!element) {return;}
            if (element.closest('#rpa-floating-panel')) {return;}
            const selector = selectorFor(element);
            if (!selector) {return;}
            emit({
                type: 'copy',
                selector,
                a11yHint: buildA11yHint(element),
                locatorCandidates: buildCandidates(element),
                scopeHint: getScopeHint(element),
            });
        },
        true,
    );

    let scrollTimer: number | null = null;
    let scrolling = false;
    const emitScroll = () => {
        emit({ type: 'scroll', scrollX: window.scrollX, scrollY: window.scrollY });
    };
    const onScroll = () => {
        if (!scrolling) {
            scrolling = true;
            emitScroll();
        }
        if (scrollTimer) {clearTimeout(scrollTimer);}
        scrollTimer = window.setTimeout(() => {
            scrollTimer = null;
            scrolling = false;
            emitScroll();
        }, 300);
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
};
