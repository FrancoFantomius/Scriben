/**
 * Handles active themes (light, dark, auto) and checkbox updates.
 */

/**
 * Persists the theme value, sets data-theme attribute on root, and
 * updates menu checkmarks UI.
 * @param {string} theme 
 */
export function applyAppTheme(theme) {
    localStorage.setItem('scriben-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    
    const autoCheck = document.getElementById('theme-auto-check');
    const lightCheck = document.getElementById('theme-light-check');
    const darkCheck = document.getElementById('theme-dark-check');

    if (autoCheck) autoCheck.style.display = (theme === 'auto') ? 'block' : 'none';
    if (lightCheck) lightCheck.style.display = (theme === 'light') ? 'block' : 'none';
    if (darkCheck) darkCheck.style.display = (theme === 'dark') ? 'block' : 'none';
}
