import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_ROUTES } from '../dist/routes.js';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function withSEOServer(callback) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'assaynova-seo-test-'));
  let child;
  let exited;
  try {
    for (const name of ['server.mjs', 'report-pdf.mjs', 'dev-client.js', 'dev', 'dist', 'package.json']) {
      await cp(path.join(project, name), path.join(fixture, name), { recursive: true });
    }
    const socket = createServer();
    await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    child = spawn(process.execPath, ['server.mjs', '--no-accounts', `--port=${port}`], {
      cwd: fixture,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 7000);
      const onData = (chunk) => {
        output += chunk;
        if (output.includes('Press Ctrl+C to stop.')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Exited early: ${output}`)); });
    });
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exited) await exited;
    await rm(fixture, { recursive: true, force: true });
  }
}

test('public routes emit unique SSR title, meta description, canonical, OpenGraph, valid JSON-LD and exactly one H1', async () => {
  await withSEOServer(async (base) => {
    const publicRoutes = PAGE_ROUTES.filter((r) => !r.noindex);
    assert.equal(publicRoutes.length, 7);
    const titles = new Set();
    const descriptions = new Set();

    for (const route of publicRoutes) {
      const response = await fetch(base + route.path);
      assert.equal(response.status, 200, route.path);
      assert.match(response.headers.get('cache-control') || '', /^public, max-age=0/);
      assert.equal(response.headers.get('x-robots-tag'), null, route.path);
      assert.match(response.headers.get('strict-transport-security') || '', /max-age=31536000/);

      const html = await response.text();
      const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
      const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)">/i);
      const canonMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]*)">/i);
      const ogImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]*)">/i);
      const jsonLdMatches = [...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];

      assert.ok(titleMatch, `Missing <title> on ${route.path}`);
      assert.ok(descMatch, `Missing meta description on ${route.path}`);
      assert.ok(canonMatch, `Missing canonical on ${route.path}`);
      assert.ok(ogImageMatch, `Missing og:image on ${route.path}`);
      assert.equal(canonMatch[1], `https://assaynovalabs.com${route.path === '/' ? '/' : route.path}`);
      assert.equal(ogImageMatch[1], 'https://assaynovalabs.com/assets/assaynova-og-card.jpg');

      titles.add(titleMatch[1]);
      descriptions.add(descMatch[1]);

      // Strip non-executable JSON data scripts before counting rendered HTML <h1> elements
      const domOnly = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      const h1Count = (domOnly.match(/<h1\b/gi) || []).length;
      assert.equal(h1Count, 1, `Expected exactly 1 <h1> in initial DOM on ${route.path}, got ${h1Count}`);

      // Non-privacy routes must not leak #privacy-policy-view prose into initial HTML DOM
      if (route.path !== '/privacy-policy') {
        assert.doesNotMatch(domOnly, /Information used to provide your account/);
      }

      assert.equal(jsonLdMatches.length, 1, `Expected 1 JSON-LD @graph block on ${route.path}`);
      const parsed = JSON.parse(jsonLdMatches[0][1]);
      assert.equal(parsed['@context'], 'https://schema.org');
      assert.ok(Array.isArray(parsed['@graph']) && parsed['@graph'].length >= 3);
    }

    assert.equal(titles.size, publicRoutes.length, 'Every public route must have a unique <title>');
    assert.equal(descriptions.size, publicRoutes.length, 'Every public route must have a unique meta description');
  });
});

test('auth/account and COA routes enforce noindex and no-store while sitemap.xml, robots.txt and llms.txt serve clean MIME types', async () => {
  await withSEOServer(async (base) => {
    for (const route of PAGE_ROUTES.filter((r) => r.noindex)) {
      const response = await fetch(base + route.path);
      assert.equal(response.status, 200, route.path);
      assert.equal(response.headers.get('cache-control'), 'no-store', route.path);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', route.path);
      const html = await response.text();
      assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
      assert.doesNotMatch(html, /<link rel="canonical"/);
    }

    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type') || '', /^text\/plain/);
    const robotsText = await robots.text();
    assert.match(robotsText, /OAI-SearchBot/);
    assert.match(robotsText, /Sitemap: https:\/\/assaynovalabs\.com\/sitemap\.xml/);

    const sitemap = await fetch(`${base}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type') || '', /^application\/xml/);
    const sitemapText = await sitemap.text();
    assert.match(sitemapText, /<loc>https:\/\/assaynovalabs\.com\/submit-sample<\/loc>/);
    assert.doesNotMatch(sitemapText, /\/login|\/account|\/coa\//);

    const llms = await fetch(`${base}/llms.txt`);
    assert.equal(llms.status, 200);
    assert.match(llms.headers.get('content-type') || '', /^text\/plain/);
    assert.match(await llms.text(), /# AssayNova/);
  });
});
