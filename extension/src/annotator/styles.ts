export const ANNOTATOR_CSS = `
.annotator-root {
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: #0f172a;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1;
    background: #fff;
    border-bottom: 1px solid #e2e8f0;
    box-shadow: 0 4px 12px rgba(15, 23, 42, .12);
}
.annotator-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #f8fafc;
    border-bottom: 1px solid #e2e8f0;
}
.annotator-mode { font-size: 12px; font-weight: 700; }
.annotator-flag { font-size: 11px; padding: 2px 6px; border-radius: 6px; background: #fee2e2; color: #b91c1c; }
.annotator-spacer { flex: 1; }
.annotator-btn {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid #cbd5e1;
    background: #fff;
    cursor: pointer;
}
.annotator-btn:disabled { opacity: .5; cursor: not-allowed; }
.annotator-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.annotator-exit { background: #111827; border-color: #111827; color: #f9fafb; }
.annotator-summary { padding: 8px 10px; }
.annotator-line { font-size: 12px; color: #475569; margin-bottom: 2px; }
`;
