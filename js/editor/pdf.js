import { state, getPages } from './state.js';

function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) {
            resolve();
            return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

export async function ensurePdfLibs() {
    const libs = [
        'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
        'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js'
    ];
    for (const src of libs) {
        await loadScript(src);
    }
}

/**
 * Generates and downloads a high-resolution PDF rendering of the current pages workspace.
 */
export async function generatePdf() {
    const { jsPDF } = window.jspdf;
    const format = state.currentDoc.pageFormat || 'a4';

    let pageWidthMM = 210;
    let pageHeightMM = 297;

    if (format === 'a5') {
        pageWidthMM = 148;
        pageHeightMM = 210;
    } else if (format === 'letter') {
        pageWidthMM = 215.9;
        pageHeightMM = 279.4;
    } else if (format === 'legal') {
        pageWidthMM = 215.9;
        pageHeightMM = 355.6;
    }

    const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: format,
        compress: true
    });

    const pages = getPages();

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];

        const canvas = await html2canvas(page, {
            scale: 2,                  // 2x resolution
            useCORS: true,             // allow cross-origin images
            allowTaint: true,
            backgroundColor: '#ffffff',
            logging: false,
            width: page.offsetWidth,
            height: page.offsetHeight,
            windowWidth: page.offsetWidth,
            windowHeight: page.offsetHeight
        });

        const imgData = canvas.toDataURL('image/png');

        if (i > 0) {
            pdf.addPage(format, 'portrait');
        }

        pdf.addImage(imgData, 'PNG', 0, 0, pageWidthMM, pageHeightMM);
    }

    const titleInput = document.querySelector('header input[type="text"]');
    const docName = (titleInput && titleInput.value.trim())
        ? titleInput.value.trim().replace(/[^a-zA-Z0-9_\- ]/g, '')
        : 'ScribenDocument';
    pdf.save(`${docName}.pdf`);
}

/**
 * Alias used by main.js imports.
 */
export { generatePdf as exportPdf };

/**
 * Wires the PDF export toolbar button.
 * Call once after the DOM is ready.
 */
export function initPdfExport() {
    const exportPdfBtn = document.getElementById('exportPdfBtn');
    if (!exportPdfBtn) return;

    exportPdfBtn.addEventListener('click', async () => {
        exportPdfBtn.disabled = true;
        const icon = exportPdfBtn.querySelector('.material-symbols-outlined');
        const origIcon = icon ? icon.textContent : '';
        if (icon) icon.textContent = 'hourglass_empty';

        try {
            document.documentElement.setAttribute('data-theme-pdf', 'true');
            await ensurePdfLibs();
            await generatePdf();
        } catch (err) {
            console.error('PDF export failed:', err);
            alert('PDF export failed. Check the console for details.');
        } finally {
            document.documentElement.removeAttribute('data-theme-pdf');
            exportPdfBtn.disabled = false;
            if (icon) icon.textContent = origIcon;
        }
    });
}
