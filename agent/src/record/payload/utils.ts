export const normalizeText = (value?: string): string =>
    (value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);

const getElementText = (el: Element): string => {
    if ('innerText' in el) {return (el as HTMLElement).innerText || el.textContent || '';}
    return el.textContent || '';
};

export const safeEscape = (value: string): string => {
    return CSS.escape(value);
};

const isStableClass = (value: string): boolean => {
    const clean = value.trim();
    if (!clean) {return false;}
    if (clean.length > 24) {return false;}
    if (/\d{4,}/.test(clean)) {return false;}
    if (/[A-Za-z]/.test(clean) && /\d/.test(clean) && clean.length >= 12) {return false;}
    return true;
};

export const selectorFor = (el: Element | null): string | null => {
    if (!el || !('tagName' in el)) {return null;}
    const dataAttrs = ['data-testid', 'data-test', 'data-qa'];
    for (const attr of dataAttrs) {
        const val = el.getAttribute(attr);
        if (val) {return `[${attr}="${safeEscape(val)}"]`;}
    }
    if ((el as HTMLElement).id) {return `#${safeEscape((el as HTMLElement).id)}`;}
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node?.nodeType === 1 && depth < 7) {
        const tag = node.tagName.toLowerCase();
        let part = tag;
        const classList = Array.from((node as HTMLElement).classList)
            .filter(isStableClass)
            .slice(0, 2)
            .map(safeEscape);
        if (classList.length) {
            part += `.${classList.join('.')}`;
        }
        if (node.parentElement) {
            const siblings = Array.from(node.parentElement.children).filter((child) => child.tagName === node!.tagName);
            if (siblings.length > 1) {
                const index = siblings.indexOf(node) + 1;
                part += `:nth-of-type(${index})`;
            }
        }
        parts.unshift(part);
        if ((node as HTMLElement).id) {break;}
        node = node.parentElement;
        depth += 1;
    }
    return parts.join(' > ');
};

export const getRole = (el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit) {return explicit;}
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') {return 'button';}
    if (tag === 'a' && el.getAttribute('href')) {return 'link';}
    if (tag === 'select') {return 'combobox';}
    if (tag === 'textarea') {return 'textbox';}
    if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') {return 'checkbox';}
        if (type === 'radio') {return 'radio';}
        if (type === 'submit' || type === 'button' || type === 'reset') {return 'button';}
        return 'textbox';
    }
    return null;
};

export const getLabelText = (el: Element): string | null => {
    const aria = el.getAttribute('aria-label');
    if (aria) {return normalizeText(aria);}
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
        const ids = labelledBy.split(/\s+/);
        const parts = ids
            .map((id) => {
                const node = document.getElementById(id);
                return node ? normalizeText(getElementText(node)) : '';
            })
            .filter(Boolean);
        if (parts.length) {return parts.join(' ');}
    }
    const id = el.getAttribute('id');
    if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) {return normalizeText(getElementText(label));}
    }
    const wrapLabel = el.closest('label');
    if (wrapLabel) {return normalizeText(getElementText(wrapLabel));}
    return null;
};

export const getTestId = (el: Element): string | null => {
    const node = el.closest('[data-testid],[data-test],[data-qa]');
    if (!node) {return null;}
    return node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-qa');
};

export const getScopeHint = (el: Element): string | null => {
    if (el.closest('aside')) {return 'aside';}
    if (el.closest('header')) {return 'header';}
    if (el.closest('main')) {return 'main';}
    return null;
};

export const getTextCandidate = (el: Element): string | null => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'li' || tag === 'span') {
        return normalizeText(getElementText(el));
    }
    return null;
};

const buildAttrSelectorCandidate = (el: Element): string | null => {
    const name = el.getAttribute('name');
    if (name) {return `[name="${safeEscape(name)}"]`;}
    const title = el.getAttribute('title');
    if (title) {return `[title="${safeEscape(title)}"]`;}
    return null;
};

export const buildCandidates = (el: Element, rawSelector?: string): Array<Record<string, unknown>> => {
    const candidates: Array<Record<string, unknown>> = [];
    const testId = getTestId(el);
    if (testId) {
        candidates.push({ kind: 'testid', testId, note: 'data-testid' });
    }
    const role = getRole(el);
    const name =
        getLabelText(el) ||
        normalizeText(getElementText(el)) ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('value');
    if (role && name) {
        candidates.push({ kind: 'role', role, name: normalizeText(name), exact: true });
    }
    const labelText = getLabelText(el);
    if (labelText) {
        candidates.push({ kind: 'label', text: labelText, exact: true });
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
        candidates.push({ kind: 'placeholder', text: normalizeText(placeholder), exact: true });
    }
    const text = getTextCandidate(el);
    if (text) {
        candidates.push({ kind: 'text', text, exact: true });
    }
    const attrSelector = buildAttrSelectorCandidate(el);
    if (attrSelector) {
        candidates.push({ kind: 'attr', selector: attrSelector, exact: true });
    }
    const css = selectorFor(el);
    if (css && normalizeText(css) !== normalizeText(rawSelector)) {
        candidates.push({ kind: 'css', selector: css });
    }
    return candidates;
};

export const buildTargetAttrs = (el: Element): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    const tag = el.tagName.toLowerCase();
    if (tag) {out.tag = tag;}
    const pairs: Array<[string, string]> = [
        ['type', 'type'],
        ['class', 'class'],
        ['name', 'name'],
        ['placeholder', 'placeholder'],
        ['title', 'title'],
        ['aria-label', 'ariaLabel'],
        ['aria-labelledby', 'ariaLabelledBy'],
        ['autocomplete', 'autocomplete'],
        ['data-testid', 'dataTestId'],
        ['data-test', 'dataTest'],
        ['data-qa', 'dataQa'],
    ];
    for (const [attr, key] of pairs) {
        const value = el.getAttribute(attr);
        if (value && value.trim()) {
            out[key] = value.trim();
        }
    }
    return Object.keys(out).length ? out : undefined;
};

export const buildTargetState = (el: Element): {
    checked?: boolean;
    focused?: boolean;
    disabled?: boolean;
    readonly?: boolean;
    ariaChecked?: string;
    ariaSelected?: string;
    ariaExpanded?: string;
    ariaDisabled?: string;
} | undefined => {
    const out: {
        checked?: boolean;
        focused?: boolean;
        disabled?: boolean;
        readonly?: boolean;
        ariaChecked?: string;
        ariaSelected?: string;
        ariaExpanded?: string;
        ariaDisabled?: string;
    } = {};
    if (el instanceof HTMLInputElement) {
        out.checked = Boolean(el.checked);
    }
    out.focused = document.activeElement === el;
    if ('disabled' in el) {
        out.disabled = Boolean((el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).disabled);
    }
    if ('readOnly' in el) {
        out.readonly = Boolean((el as HTMLInputElement | HTMLTextAreaElement).readOnly);
    }
    const ariaPairs: Array<[string, 'ariaChecked' | 'ariaSelected' | 'ariaExpanded' | 'ariaDisabled']> = [
        ['aria-checked', 'ariaChecked'],
        ['aria-selected', 'ariaSelected'],
        ['aria-expanded', 'ariaExpanded'],
        ['aria-disabled', 'ariaDisabled'],
    ];
    for (const [attr, key] of ariaPairs) {
        const value = el.getAttribute(attr);
        if (value && value.trim()) {
            out[key] = value.trim();
        }
    }
    return Object.keys(out).length ? out : undefined;
};

export const buildA11yHint = (el: Element): Record<string, string> => {
    const role = getRole(el);
    const name =
        getLabelText(el) ||
        normalizeText(getElementText(el)) ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('value');
    const text = name ? normalizeText(name) : getTextCandidate(el);
    const hint: Record<string, string> = {};
    if (role) {hint.role = role;}
    if (name) {hint.name = normalizeText(name);}
    if (text) {hint.text = normalizeText(text);}
    return hint;
};

const NATIVE_INTERACTIVE_TAGS = new Set([
    'button', 'input', 'select', 'textarea', 'summary', 'label',
]);

const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'menuitem', 'option', 'radio', 'checkbox',
    'switch', 'tab', 'treeitem', 'combobox',
]);

const FRAMEWORK_BUTTON_CLASSES = new Set([
    'ant-btn', 'el-button', 'arco-btn', 'semi-button', 'btn', 'button',
]);

const CONTAINER_ROLES = new Set([
    'tabpanel', 'region', 'main', 'form', 'group', 'presentation',
    'none', 'row', 'cell', 'grid', 'table', 'list', 'listitem',
]);

const MAX_CURSOR_POINTER_STEPS = 3;

export const pickClickTarget = (element: Element): Element => {
    let node: Element | null = element;
    let candidate: Element | null = null;
    let cursorSteps = 0;

    while (node && node !== document.body && node !== document.documentElement) {
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute('role');

        if (NATIVE_INTERACTIVE_TAGS.has(tag)) {
            return node;
        }
        if (tag === 'a' && node.hasAttribute('href')) {
            return node;
        }

        if (role && INTERACTIVE_ROLES.has(role)) {
            return node;
        }

        if (role && CONTAINER_ROLES.has(role)) {
            return candidate || element;
        }

        if (!candidate) {
            const classList = (node as HTMLElement).classList;
            if (classList) {
                for (const cls of Array.from(classList)) {
                    if (FRAMEWORK_BUTTON_CLASSES.has(cls)) {
                        candidate = node;
                        break;
                    }
                }
            }
        }

        if (!candidate && cursorSteps < MAX_CURSOR_POINTER_STEPS) {
            cursorSteps += 1;
            try {
                const style = window.getComputedStyle(node);
                if (style.cursor === 'pointer') {
                    candidate = node;
                }
            } catch {
                // ignore
            }
        }

        node = node.parentElement;
    }

    return candidate || element;
};

export const isPassword = (el: Element): boolean => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'password' || el.getAttribute('autocomplete') === 'current-password';
};

export const getValue = (el: Element): string => {
    if (isPassword(el)) {return '***';}
    if ('value' in el) {return (el as HTMLInputElement).value;}
    return el.textContent || '';
};

export const isCheckboxOrRadio = (el: Element): boolean => {
    if (!(el instanceof HTMLInputElement)) {return false;}
    const type = (el.type || '').toLowerCase();
    return type === 'checkbox' || type === 'radio';
};

export const findCheckboxInput = (target: Element | null): HTMLInputElement | null => {
    if (!target) {return null;}
    if (target instanceof HTMLInputElement) {
        const type = (target.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {return target;}
    }
    const label = target.closest('label');
    if (label) {
        const input = label.querySelector('input[type="checkbox"], input[type="radio"]');
        if (input) {return input as HTMLInputElement;}
    }
    const roleHost = target.closest('[role="checkbox"], [role="radio"]');
    if (roleHost) {
        const roleInput = roleHost.querySelector('input[type="checkbox"], input[type="radio"]');
        if (roleInput) {return roleInput as HTMLInputElement;}
    }
    return null;
};
