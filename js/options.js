/**
 * Dynamic options handling for the Scriben Editor.
 */

/**
 * Fetches the font selection configurations, injects Google Fonts link tags,
 * and populates the given select element.
 * @param {HTMLSelectElement} fontSelectElement 
 */
export async function initFonts(fontSelectElement) {
    try {
        const response = await fetch('/fonts.json');
        if (!response.ok) {
            throw new Error(`Failed to load fonts.json: ${response.status}`);
        }
        const fonts = await response.json();

        // 1. Inject Google Fonts Link dynamically
        const googleFamilies = fonts
            .filter(f => f.googleFont)
            .map(f => {
                const gf = f.googleFont;
                return gf.startsWith('family=') ? gf : `family=${gf}`;
            })
            .join('&');

        if (googleFamilies) {
            // Check if preconnect links exist, if not add them
            if (!document.querySelector('link[href="https://fonts.googleapis.com"]')) {
                const preconnectGoogle = document.createElement('link');
                preconnectGoogle.rel = 'preconnect';
                preconnectGoogle.href = 'https://fonts.googleapis.com';
                document.head.appendChild(preconnectGoogle);
            }
            if (!document.querySelector('link[href="https://fonts.gstatic.com"]')) {
                const preconnectGstatic = document.createElement('link');
                preconnectGstatic.rel = 'preconnect';
                preconnectGstatic.href = 'https://fonts.gstatic.com';
                preconnectGstatic.crossOrigin = 'anonymous';
                document.head.appendChild(preconnectGstatic);
            }

            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.id = 'dynamic-google-fonts';
            link.href = `https://fonts.googleapis.com/css2?${googleFamilies}&display=swap`;
            document.head.appendChild(link);
        }

        // 2. Populate the select element
        if (fontSelectElement) {
            fontSelectElement.innerHTML = '';
            fonts.forEach(font => {
                const option = document.createElement('option');
                option.value = font.css;
                option.style.fontFamily = font.css;
                option.textContent = font.name;
                fontSelectElement.appendChild(option);
            });
        }
        return fonts;
    } catch (err) {
        console.error("Error loading fonts in options.js:", err);
    }
}
