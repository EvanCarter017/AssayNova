// Exact first-party page routes shared by the browser and the local HTTP server.
export const PAGE_ROUTES = Object.freeze([
  { path: '/', view: 'home-view', heading: 'hero-title', title: 'AssayNova — A clearer view of your sample.' },
  { path: '/testing-methods', view: 'testing-view', heading: 'testing-page-title', title: 'Testing Methods · AssayNova' },
  { path: '/about', view: 'about-view', heading: 'about-title', title: 'About us · AssayNova' },
  { path: '/verify', view: 'verify-view', heading: 'verify-page-title', title: 'Verify COA · AssayNova' },
  { path: '/contact', view: 'contact-view', heading: 'contact-title', title: 'Contact us · AssayNova' }
].map(Object.freeze));

export function resolvePageRoute(pathname) {
  // Do not decode paths: encoded separators/aliases are not page rewrites.
  if (typeof pathname !== 'string' || !/^\/(?:[a-z-]+\/?)?$/.test(pathname)) return null;
  const path = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  return PAGE_ROUTES.find((route) => route.path === path) || null;
}
