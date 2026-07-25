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
        const response = await fetch('./fonts.json');
        if (!response.ok) {
            throw new Error(`Failed to load fonts.json: ${response.status}`);
        }
        const fonts = await response.json();

        // Populate the select element with self-hosted / local font definitions
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
