import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PAGE_ROUTES, resolvePageRoute } from '../dist/routes.js';

test('page allowlist resolves ten explicit paths and canonical trailing slashes', () => {
  assert.deepEqual(PAGE_ROUTES.map(({ path }) => path), ['/', '/testing-methods', '/about', '/verify', '/contact', '/submit-sample', '/account', '/login', '/register', '/recover-account']);
  for (const route of PAGE_ROUTES) {
    assert.equal(resolvePageRoute(route.path), route);
    assert.ok(Object.isFrozen(route));
    if (route.path !== '/') assert.equal(resolvePageRoute(route.path + '/'), route);
  }
  assert.ok(Object.isFrozen(PAGE_ROUTES));
});

test('page routing never rewrites unrelated, asset, dev, malformed or encoded paths', () => {
  for (const value of [null, undefined, {}, '', '//', '/about//', '/About', '/about?x=1', '/about#main', '/missing', '/app.js', '/styles.css', '/assets/a.png', '/__dev', '/__dev/status', '/coa/AN-7K9Q-2M4X', '/%61bout', '/about%2f', '/%2fabout', '/about%5c', '/%ZZ', '/about/extra', '\\about']) assert.equal(resolvePageRoute(value), null, String(value));
});

test('page markup has unique IDs and one static heading/view per declared page', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Static IDs must not be duplicated when sections move');
  assert.match(html, /<main\b[^>]*id="main"[^>]*tabindex="-1"/, 'The native skip-link target must accept focus');
  for (const route of PAGE_ROUTES) {
    assert.ok(ids.includes(route.view));
    assert.match(html, new RegExp(`<h1[^>]*id="${route.heading}"[^>]*tabindex="-1"`));
  }
});

test('active markup has account submissions and no device draft actions or standalone contact bootstrap',async()=>{
 const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/Save draft|Device drafts|Restore saved|Clear saved|This device|src="\/contact-form\.js"/);assert.match(html,/Submit message/);assert.match(html,/My requests/);const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');assert.doesNotMatch(app,/localStorage|readRequests|copyDeviceRequest/);assert.equal((app.match(/createCustomerAccountClient\(\)/g)||[]).length,1);
});
