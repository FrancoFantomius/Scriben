/**
 * toast.js — tiny standalone toast helper shared by the DOCX import/export
 * entry points. Kept free of app-level imports so either pipeline can be used
 * headless without pulling in the editor's database layer.
 */

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Shows a small stacked toast with an optional list of lines (max 5 shown,
 * then "and N more"). No-op without a DOM.
 * @param {string} title
 * @param {string[]} [lines]
 */
export function showToast(title, lines = []) {
    if (typeof document === 'undefined' || !document.body) return;
    let container = document.getElementById('scriben-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'scriben-toast-container';
        container.style.cssText = [
            'position: fixed',
            'bottom: 24px',
            'left: 50%',
            'transform: translateX(-50%)',
            'z-index: 20000',
            'display: flex',
            'flex-direction: column',
            'gap: 8px',
            'align-items: center',
            'font-family: var(--font-ui, "Google Sans", sans-serif)',
            'pointer-events: none'
        ].join('; ');
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.style.cssText = [
        'background: var(--color-dropdown-bg, #ffffff)',
        'color: var(--color-text, #202124)',
        'border: 1px solid var(--color-toolbar-border, #dadce0)',
        'border-radius: 8px',
        'box-shadow: 0 4px 12px rgba(0,0,0,0.18)',
        'padding: 12px 16px',
        'max-width: 440px',
        'font-size: 13px',
        'line-height: 1.45',
        'box-sizing: border-box',
        'pointer-events: auto'
    ].join('; ');

    let html = `<div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(title)}</div>`;
    const shown = lines.slice(0, 5);
    if (shown.length > 0) {
        html += '<div style="color: var(--color-text-secondary, #5f6368);">';
        html += shown.map(l => `• ${escapeHtml(l)}`).join('<br>');
        if (lines.length > shown.length) {
            html += `<br>and ${lines.length - shown.length} more`;
        }
        html += '</div>';
    }
    toast.innerHTML = html;

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}
