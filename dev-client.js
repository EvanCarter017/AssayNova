// Development-only live updates. Injected by server.mjs --watch; never shipped in dist/.
const events = new EventSource('/__dev/events');
let connectedVersion;
let seenRevision;

events.addEventListener('connected', (event) => {
  const state = JSON.parse(event.data);
  if ((connectedVersion && state.version !== connectedVersion) ||
      (seenRevision !== undefined && state.revision !== seenRevision)) {
    location.reload();
    return;
  }
  connectedVersion = state.version;
  seenRevision = state.revision;
  console.info('[AssayNova] Live updates connected.');
});

events.addEventListener('change', (event) => {
  const { paths, revision } = JSON.parse(event.data);
  seenRevision = revision;
  if (!paths.every((path) => path.endsWith('.css'))) {
    location.reload();
    return;
  }
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const url = new URL(link.href);
    if (url.origin !== location.origin || !paths.includes(url.pathname)) continue;
    url.searchParams.set('__live', revision);
    const replacement = link.cloneNode();
    replacement.href = url.href;
    replacement.addEventListener('load', () => link.remove(), { once: true });
    replacement.addEventListener('error', () => location.reload(), { once: true });
    link.after(replacement);
  }
  console.info('[AssayNova] Styles updated:', paths.join(', '));
});

window.addEventListener('pagehide', () => events.close(), { once: true });
