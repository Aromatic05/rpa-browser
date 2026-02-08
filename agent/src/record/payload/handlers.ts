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

const isEventHandled = (event: Event & { __rpaRecorderHandled?: boolean }) => {
    if (event.__rpaRecorderHandled) return true;
    event.__rpaRecorderHandled = true;
    return false;
};

const inPanel = (path: EventTarget[] | null) => {
    if (!path) return false;
    for (const node of path) {
        if (node && (node as HTMLElement).id === 'rpa-floating-panel') return true;
    }
    return false;
};

export const installHandlers = (emit: EmitFn, debugTarget: DebugTargetFn) => {
    const handleClick = (event: MouseEvent & { __rpaRecorderHandled?: boolean }) => {
        if (isEventHandled(event)) return;
        const path = event.composedPath ? event.composedPath() : null;
        let target = (path && path[0]) || event.target;
        if (target && (target as Node).nodeType === 3) target = (target as Node).parentElement;
        const element = target instanceof Element ? target : null;
        if (!element) return;
        if (inPanel(path) || (element.closest && element.closest('#rpa-floating-panel'))) return;
        if (isCheckboxOrRadio(element) || element.closest('label input[type="checkbox"], label input[type="radio"]')) return;
        const checkboxInput = findCheckboxInput(element);
        if (checkboxInput) return;
        const selector = selectorFor(element);
        if (selector) {
            emit({
                type: 'click',
                selector,
                targetHint: element.tagName.toLowerCase(),
                a11yHint: buildA11yHint(element),
                locatorCandidates: buildCandidates(element),
                scopeHint: getScopeHint(element),
            });
            return;
        }
        const fallback = element.closest && element.closest('button, a, input, select, textarea, [role]');
        if (!fallback) {
            debugTarget('click', element, 'no selector and no fallback');
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
        if (hintOnly && (hintOnly.role || hintOnly.name || hintOnly.text)) {
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
    window.addEventListener('click', handleClick, true);

    document.addEventListener(
        'input',
        (event) => {
            const target = (event.composedPath && event.composedPath()[0]) || event.target;
            const element = target instanceof Element ? target : null;
            if (!element) return;
            if (element.closest && element.closest('#rpa-floating-panel')) return;
            if (isCheckboxOrRadio(element)) return;
            if (element instanceof HTMLSelectElement) return;
            const selector = selectorFor(element);
            if (!selector) return;
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
            const target = (event.composedPath && event.composedPath()[0]) || event.target;
            const element = target instanceof Element ? target : null;
            if (!element) return;
            if (element.closest && element.closest('#rpa-floating-panel')) return;
            const selector = selectorFor(element);
            if (!selector) return;
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
                const option = element.selectedOptions && element.selectedOptions[0];
                emit({
                    type: 'select',
                    selector,
                    value: element.value,
                    label: option ? option.label : '',
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
            if (!specialKeys.has(event.key)) return;
            const target = (event.composedPath && event.composedPath()[0]) || event.target;
            const element = target instanceof Element ? target : null;
            if (element && element.closest && element.closest('#rpa-floating-panel')) return;
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
            const target = (event.composedPath && event.composedPath()[0]) || event.target;
            const element = target instanceof Element ? target : null;
            if (!element) return;
            if (element.closest && element.closest('#rpa-floating-panel')) return;
            const selector = selectorFor(element);
            if (!selector) return;
            if (isPassword(element)) return;
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
            const target = (event.composedPath && event.composedPath()[0]) || event.target;
            const element = target instanceof Element ? target : null;
            if (!element) return;
            if (element.closest && element.closest('#rpa-floating-panel')) return;
            const selector = selectorFor(element);
            if (!selector) return;
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
    const onScroll = () => {
        if (scrollTimer) clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
            scrollTimer = null;
            emit({ type: 'scroll', scrollX: window.scrollX, scrollY: window.scrollY });
        }, 200);
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
};
