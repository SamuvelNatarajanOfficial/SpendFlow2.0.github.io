// Applies the stored theme before first paint (avoids a flash). Kept as an external file so the page can use a
// Content-Security-Policy without 'unsafe-inline' scripts. The theme is a non-sensitive UI preference.
try {
  var t = localStorage.getItem('sf-theme')
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', t)
} catch (e) {}
