import path from 'node:path';
import { canonicalOrigin, loopback, privatePeer } from './boundary.mjs';
import { DEFAULT_ACCOUNT_STORE } from './database.mjs';

export function accountConfiguration({ argv = [], env = {}, port, bindAddress, adminProxy } = {}) {
  if (argv.includes('--no-accounts')) return { mode: 'disabled' };
  const option = name => {
    const matches = argv.filter(value => value === name || value.startsWith(name + '='));
    if (matches.length > 1 || (matches.length && !matches[0].startsWith(name + '='))) throw new Error('Supply each account option once, with a value.');
    return matches[0]?.slice(name.length + 1);
  };
  const production = env.NODE_ENV === 'production';
  if (adminProxy) {
    if (option('--account-store') || option('--account-origin')) throw new Error('The account bridge must not configure an account database or authority origin.');
    return { mode: 'proxy', ...adminProxy, port, bindAddress, production };
  }
  const explicitOrigin = option('--account-origin') ?? env.ASSAYNOVA_ACCOUNT_ORIGIN;
  const host = bindAddress === '::1' ? '[::1]' : bindAddress;
  const origin = explicitOrigin ?? `http://${host}:${port}`;
  const url = canonicalOrigin(origin);
  if (production && (!explicitOrigin || url.protocol !== 'https:' || !loopback(bindAddress))) throw new Error('Production customer accounts require an explicit HTTPS origin and loopback authority.');
  if (!loopback(bindAddress) && (!explicitOrigin || !privatePeer(url.hostname) || Number(url.port) !== port || !privatePeer(bindAddress === '0.0.0.0' ? url.hostname : bindAddress))) throw new Error('A nonloopback account listener needs an explicitly configured private origin or the account bridge.');
  if (!production && url.protocol === 'http:' && !privatePeer(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Plain HTTP customer accounts are limited to local/private preview origins.');
  const directory = option('--account-store') ?? env.ASSAYNOVA_ACCOUNT_STORE ?? DEFAULT_ACCOUNT_STORE;
  if (!path.isAbsolute(directory)) throw new Error('Choose an absolute private account directory.');
  return { mode: 'authority', directory, origins: [url.origin], port, allowPrivate: !loopback(bindAddress), production };
}
