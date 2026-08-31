/**
 * Product shell styles: semantic, non-brand design tokens and scoped layout
 * (spec §15). All styles live inside the shadow root; `:host { all: initial }`
 * guarantees no page styles leak in and none leak out.
 */
export const productStyles = `
:host {
    all: initial;
}
.rpa-root {
    --rpa-surface: #ffffff;
    --rpa-surface-raised: #f8fafc;
    --rpa-border: #e2e8f0;
    --rpa-text: #0f172a;
    --rpa-text-muted: #64748b;
    --rpa-accent: #2563eb;
    --rpa-danger: #dc2626;
    --rpa-success: #16a34a;
    --rpa-warning: #d97706;
    --rpa-error: #b91c1c;
    --rpa-info: #0284c7;
    --rpa-focus-ring: #2563eb;

    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.45;
    color: var(--rpa-text);
    background: var(--rpa-surface);
    box-sizing: border-box;
}
.rpa-root *,
.rpa-root *::before,
.rpa-root *::after {
    box-sizing: border-box;
}
.rpa-launcher,
.rpa-panel {
    pointer-events: auto;
}

/* ---- Launcher (spec §3) ---- */
.rpa-launcher {
    position: fixed;
    top: 50%;
    right: 12px;
    transform: translateY(-50%);
    width: 44px;
    height: 44px;
    border-radius: 999px;
    border: none;
    background: var(--rpa-text);
    color: var(--rpa-surface);
    font-size: 17px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.22);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
}
.rpa-launcher:focus-visible {
    outline: 2px solid var(--rpa-focus-ring);
    outline-offset: 2px;
}
.rpa-launcher-dot {
    position: absolute;
    bottom: 2px;
    right: 2px;
    width: 10px;
    height: 10px;
    border-radius: 999px;
    border: 2px solid var(--rpa-surface);
    background: var(--rpa-text-muted);
}
.rpa-launcher-dot--running {
    background: var(--rpa-info);
}
.rpa-launcher-dot--waiting {
    background: var(--rpa-warning);
}
.rpa-launcher-dot--teach {
    background: var(--rpa-danger);
}
.rpa-launcher-dot--disconnected {
    background: var(--rpa-text-muted);
}
.rpa-launcher-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 18px;
    height: 18px;
    border-radius: 999px;
    background: var(--rpa-warning);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
}

/* ---- Panel shell (spec §4) ---- */
.rpa-panel {
    position: fixed;
    top: 0;
    right: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--rpa-surface);
    border-left: 1px solid var(--rpa-border);
    box-shadow: -12px 0 28px rgba(15, 23, 42, 0.18);
    z-index: 1;
}
.rpa-panel[hidden] {
    display: none;
}
.rpa-resize {
    position: absolute;
    top: 0;
    left: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    touch-action: none;
}
.rpa-header {
    min-height: 48px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px;
    border-bottom: 1px solid var(--rpa-border);
    background: var(--rpa-surface);
}
.rpa-brand {
    font-size: 17px;
    font-weight: 700;
    margin-right: 8px;
}
.rpa-nav {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
}
.rpa-nav-btn {
    border: none;
    background: transparent;
    color: var(--rpa-text-muted);
    font-size: 13px;
    padding: 6px 10px;
    border-radius: 8px;
    cursor: pointer;
}
.rpa-nav-btn:hover {
    background: var(--rpa-surface-raised);
    color: var(--rpa-text);
}
.rpa-nav-btn.active {
    color: var(--rpa-accent);
    font-weight: 700;
    background: var(--rpa-surface-raised);
}
.rpa-nav-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.rpa-header-tools {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    flex: 0 0 auto;
}
.rpa-header-action {
    padding: 5px 8px;
    white-space: nowrap;
}
.rpa-icon-btn {
    border: none;
    background: transparent;
    color: var(--rpa-text-muted);
    width: 28px;
    height: 28px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
}
.rpa-icon-btn:hover {
    background: var(--rpa-surface-raised);
    color: var(--rpa-text);
}
.rpa-icon-btn.active {
    color: var(--rpa-accent);
}

.rpa-body {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px;
    background: var(--rpa-surface-raised);
}
.rpa-footer {
    flex: 0 0 auto;
    border-top: 1px solid var(--rpa-border);
    padding: 8px 12px;
    background: var(--rpa-surface);
}

/* ---- Surface headers / banners ---- */
.rpa-connection-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--rpa-border);
    background: var(--rpa-surface-raised);
    font-size: 12px;
    color: var(--rpa-text);
}
.rpa-dev-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--rpa-border);
    background: var(--rpa-surface-raised);
    font-size: 12px;
    color: var(--rpa-text);
}
.rpa-human-control-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--rpa-warning);
    border-radius: 8px;
    background: rgba(217, 119, 6, 0.08);
    color: var(--rpa-text);
    margin-bottom: 12px;
}

/* ---- Cards / typography ---- */
.rpa-section-title {
    font-size: 17px;
    font-weight: 700;
    margin: 0 0 12px;
}
.rpa-card-title {
    font-size: 15px;
    font-weight: 700;
    margin: 0 0 4px;
}
.rpa-card {
    background: var(--rpa-surface);
    border: 1px solid var(--rpa-border);
    border-radius: 12px;
    padding: 12px;
    margin-bottom: 12px;
}
.rpa-card > * + * {
    margin-top: 8px;
}
.rpa-muted {
    color: var(--rpa-text-muted);
    font-size: 12px;
}
.rpa-hint {
    color: var(--rpa-text-muted);
    font-size: 11px;
}
.rpa-empty {
    color: var(--rpa-text-muted);
    font-size: 12px;
    padding: 8px 0;
}
.rpa-field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 4px;
}
.rpa-input,
.rpa-textarea,
.rpa-select {
    width: 100%;
    box-sizing: border-box;
    padding: 8px;
    font-size: 13px;
    font-family: inherit;
    color: var(--rpa-text);
    background: var(--rpa-surface);
    border: 1px solid var(--rpa-border);
    border-radius: 8px;
}
.rpa-textarea {
    min-height: 96px;
    max-height: 240px;
    resize: vertical;
}
.rpa-input:focus-visible,
.rpa-textarea:focus-visible,
.rpa-select:focus-visible,
.rpa-btn:focus-visible,
.rpa-details summary:focus-visible {
    outline: 2px solid var(--rpa-focus-ring);
    outline-offset: 1px;
}
.rpa-error-strip {
    border: 1px solid var(--rpa-error);
    background: rgba(185, 28, 28, 0.06);
    color: var(--rpa-error);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12px;
}

/* ---- Buttons (spec §15 hierarchy) ---- */
.rpa-btn {
    font-family: inherit;
    font-size: 13px;
    padding: 7px 12px;
    border-radius: 8px;
    border: 1px solid var(--rpa-border);
    background: var(--rpa-surface);
    color: var(--rpa-text);
    cursor: pointer;
}
.rpa-btn--primary {
    background: var(--rpa-accent);
    border-color: var(--rpa-accent);
    color: #fff;
    font-weight: 600;
}
.rpa-btn--danger {
    background: transparent;
    border-color: var(--rpa-danger);
    color: var(--rpa-danger);
}
.rpa-btn--danger.rpa-btn--armed {
    background: var(--rpa-danger);
    color: #fff;
}
.rpa-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.rpa-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.rpa-row--between {
    justify-content: space-between;
}
.rpa-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
}

/* ---- Status conventions (icon + text, color-independent) ---- */
.rpa-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
}
.rpa-status-text {
    white-space: nowrap;
}
.rpa-status--running {
    color: var(--rpa-text);
}
.rpa-status--waiting {
    color: var(--rpa-warning);
}
.rpa-status--success {
    color: var(--rpa-success);
}
.rpa-status--error {
    color: var(--rpa-error);
}
.rpa-status--info {
    color: var(--rpa-info);
}
.rpa-status--muted {
    color: var(--rpa-text-muted);
}
.rpa-pulse .rpa-icon {
    animation: rpa-pulse 1.6s ease-in-out infinite;
}

/* ---- Timeline (spec §6) ---- */
.rpa-timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.rpa-timeline-item {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
}
.rpa-timeline-item .rpa-icon {
    color: var(--rpa-text-muted);
}
.rpa-timeline-item--effect .rpa-icon {
    color: var(--rpa-info);
}
.rpa-timeline-item--conflict .rpa-icon {
    color: var(--rpa-warning);
}
.rpa-timeline-item--resolved .rpa-icon {
    color: var(--rpa-success);
}
.rpa-timeline-time {
    margin-left: auto;
    color: var(--rpa-text-muted);
    font-size: 11px;
}

/* ---- Library (spec §9.3) ---- */
.rpa-library-section {
    margin-bottom: 16px;
}
.rpa-library-heading {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--rpa-text-muted);
    margin: 0 0 6px;
}
.rpa-library-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--rpa-border);
    border-radius: 8px;
    background: var(--rpa-surface);
    margin-bottom: 6px;
}
.rpa-library-item .rpa-library-main {
    flex: 1;
    min-width: 0;
}
.rpa-library-name {
    font-size: 13px;
    font-weight: 600;
}
.rpa-library-meta {
    font-size: 11px;
    color: var(--rpa-text-muted);
}

/* ---- Developer disclosure (spec §10) ---- */
.rpa-dev-disclosure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    color: var(--rpa-text-muted);
}
.rpa-dev-surface {
    padding: 12px;
    border: 1px dashed var(--rpa-border);
    border-radius: 8px;
    background: var(--rpa-surface);
}

/* ---- Details collapsible ---- */
.rpa-details {
    font-size: 12px;
    color: var(--rpa-text-muted);
}
.rpa-details summary {
    cursor: pointer;
    color: var(--rpa-text);
}
.rpa-details-list {
    margin: 6px 0 0;
    padding-left: 16px;
}

.rpa-options {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.rpa-option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--rpa-border);
    border-radius: 8px;
    background: var(--rpa-surface);
}
.rpa-option--recommended {
    border-color: var(--rpa-accent);
}
.rpa-option--disabled {
    opacity: 0.6;
}

@keyframes rpa-pulse {
    0%,
    100% {
        opacity: 1;
    }
    50% {
        opacity: 0.35;
    }
}

/* ---- Indeterminate progress (spec §6) ---- */
.rpa-indeterminate-wrap {
    margin: 4px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.rpa-indeterminate {
    height: 4px;
    border-radius: 999px;
    background: var(--rpa-surface-raised);
    overflow: hidden;
    position: relative;
}
.rpa-indeterminate::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 40%;
    left: -40%;
    background: var(--rpa-accent);
    animation: rpa-slide 1.4s ease-in-out infinite;
}
@keyframes rpa-slide {
    0% {
        left: -40%;
    }
    100% {
        left: 100%;
    }
}

/* ---- History cards ---- */
.rpa-history-card {
    cursor: pointer;
}

/* ---- Teach setup ---- */
.rpa-teach-option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 0;
}
.rpa-teach-option .rpa-hint {
    display: block;
    width: 100%;
}

@media (prefers-reduced-motion: reduce) {
    .rpa-pulse .rpa-icon {
        animation: none;
    }
    .rpa-indeterminate::after {
        animation: none;
        display: none;
    }
}
`;