/**
 * Applies the persisted theme before the first paint.
 *
 * This runs synchronously in <head>, ahead of hydration, so a user who has
 * chosen light mode never sees a frame of dark chrome (or vice versa). The
 * preference lives in localStorage rather than the encrypted vault on purpose:
 * it must be readable while the app is still locked, and "which theme" is not
 * health data.
 */
const SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('keel.theme');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
