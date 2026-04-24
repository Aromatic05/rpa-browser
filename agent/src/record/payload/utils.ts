export const normalizeText = (value?: string) =>
    (value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);

const getElementText = (el: Element) => {
    if ('innerText' in el) {return (el as HTMLElement).innerText || el.textContent || '';}
    return el.textContent || '';
};

export const safeEscape = (value: string) => {
    if ((window as any).CSS?.escape) {return (window as any).CSS.escape(value);}
    return value.replace(/[^a-zA-Z0-9_-]/g, '');
};

const isStableClass = (value: string) => {
    const clean = value.trim();
    if (!clean) {return false;}
    if (clean.length > 24) {return false;}
    if (/\d{4,}/.test(clean)) {return false;}
    if (/[A-Za-z]/.test(clean) && /\d/.test(clean) && clean.length >= 12) {return false;}
    return true;
};

export const selectorFor = (el: Element | null) => {
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
        const classList = Array.from((node as HTMLElement).classList || [])
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

export const getRole = (el: Element) => {
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

export const getLabelText = (el: Element) => {
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

export const getTestId = (el: Element) => {
    const node = el.closest('[data-testid],[data-test],[data-qa]');
    if (!node) {return null;}
    return node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-qa');
};

export const getScopeHint = (el: Element) => {
    if (el.closest('aside')) {return 'aside';}
    if (el.closest('header')) {return 'header';}
    if (el.closest('main')) {return 'main';}
    return null;
};

export const getTextCandidate = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'li' || tag === 'span') {
        return normalizeText(getElementText(el));
    }
    return null;
};

export const buildCandidates = (el: Element) => {
    const candidates: any[] = [];
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
        candidates.push({ kind: 'role', role, name: normalizeText(String(name)), exact: true });
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
    const css = selectorFor(el);
    if (css) {
        candidates.push({ kind: 'css', selector: css });
    }
    return candidates;
};

export const buildA11yHint = (el: Element) => {
    const role = getRole(el);
    const name =
        getLabelText(el) ||
        normalizeText(getElementText(el)) ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('value');
    const text = name ? normalizeText(String(name)) : getTextCandidate(el);
    const hint: Record<string, string> = {};
    if (role) {hint.role = role;}
    if (name) {hint.name = normalizeText(String(name));}
    if (text) {hint.text = normalizeText(String(text));}
    return hint;
};

export const isPassword = (el: Element) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'password' || el.getAttribute('autocomplete') === 'current-password';
};

export const getValue = (el: Element) => {
    if (isPassword(el)) {return '***';}
    if ('value' in el) {return (el as HTMLInputElement).value;}
    return el.textContent || '';
};

export const isCheckboxOrRadio = (el: Element) => {
    if (!(el instanceof HTMLInputElement)) {return false;}
    const type = (el.type || '').toLowerCase();
    return type === 'checkbox' || type === 'radio';
};

export const findCheckboxInput = (target: Element | null) => {
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
