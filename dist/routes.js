// Exact first-party page routes shared by the browser and the local HTTP server.
export const PAGE_ROUTES = Object.freeze([
  { path: '/', view: 'home-view', heading: 'hero-title', title: 'AssayNova — A clearer view of your sample.' },
  { path: '/testing-methods', view: 'testing-view', heading: 'testing-page-title', title: 'Our Testing · AssayNova' },
  { path: '/about', view: 'about-view', heading: 'about-title', title: 'About us · AssayNova' },
  { path: '/verify', view: 'verify-view', heading: 'verify-page-title', title: 'Verify COA · AssayNova' },
  { path: '/contact', view: 'contact-view', heading: 'contact-title', title: 'Contact us · AssayNova' },
  { path: '/submit-sample', view: 'request-view', heading: 'request-page-title', title: 'Submit a sample · AssayNova' },
  { path: '/account', view: 'account-view', heading: 'account-title', title: 'My account · AssayNova' },
  { path: '/login', view: 'login-view', heading: 'login-title', title: 'Sign in · AssayNova' },
  { path: '/register', view: 'register-view', heading: 'register-title', title: 'Create account · AssayNova' },
  { path: '/verify-email', view: 'verify-email-view', heading: 'verify-email-title', title: 'Verify email · AssayNova' },
  { path: '/reset-password', view: 'reset-password-view', heading: 'reset-password-title', title: 'Reset password · AssayNova' },
  { path: '/recover-account', view: 'recover-account-view', heading: 'recover-account-title', title: 'Account recovery · AssayNova' }
].map(Object.freeze));

export function resolvePageRoute(pathname) {
  // Do not decode paths: encoded separators/aliases are not page rewrites.
  if (typeof pathname !== 'string' || !/^\/(?:[a-z-]+\/?)?$/.test(pathname)) return null;
  const path = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  return PAGE_ROUTES.find((route) => route.path === path) || null;
}
