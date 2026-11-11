import dns from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { HttpError } from './validate.ts';

/**
 * Fetches a website's own icon, only when the user asks for it. The request goes
 * straight to that site (no third-party favicon service), and private, loopback
 * and link-local addresses are refused so this can't be used to probe the local
 * network.
 */

export type IconFetcher = (url: URL) => Promise<Response>;

const MAX_HTML = 512 * 1024;
const MAX_ICON = 512 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && Number(ip.split('.')[2]) === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  // URL parsing rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1.
  const mapped = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) can wrap any IPv4 address, private ones included.
  if (v6.startsWith('64:ff9b:') || v6.startsWith('2002:')) return true;
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Only web addresses are supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new HttpError(400, 'That address is on your own network');
  }
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new HttpError(400, 'Couldn’t find that website');
  if (addrs.some(isPrivateAddress)) throw new HttpError(400, 'That address is on your own network');
}

/** Normalises what the user typed ("github.com", "https://github.com/login") to the site's origin. */
export function siteUrl(raw: string): URL {
  const text = raw.trim();
  if (!text) throw new HttpError(400, 'Add a website first');
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return new URL(url.origin);
  } catch {
    throw new HttpError(400, 'That doesn’t look like a website address');
  }
}

/**
 * Resolves the host for the connection itself and refuses private addresses there. Checking the name
 * first and then letting fetch() look it up again would leave a gap: a site could answer with a public
 * address for the check and a local one for the request (DNS rebinding).
 */
const publicOnlyLookup: net.LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as { address: string; family: number }[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error('That address is on your own network'), { code: 'EPRIVATE' }), '', 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

const defaultFetcher: IconFetcher = (url) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(
      url,
      {
        lookup: publicOnlyLookup,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Keys-Password-Manager)', Accept: '*/*' },
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, headers }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('The website took too long to answer')));
    req.on('error', reject);
  });

/** Follows redirects by hand so every hop is checked against the private-address rule. */
async function get(url: URL, fetcher: IconFetcher, check: boolean): Promise<{ res: Response; url: URL }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (check) await assertPublic(current);
    const res = await fetcher(current);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    return { res, url: current };
  }
  throw new HttpError(502, 'The website redirected too many times');
}

async function readLimited(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new HttpError(502, 'The icon is too large');
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new HttpError(502, 'The icon is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Icon links in the page's <head>, best first: big touch icons, then sized icons, then plain ones. */
export function iconCandidates(html: string, base: URL): URL[] {
  const found: { url: URL; rank: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find((v) => v !== undefined);
    const rel = (attr('rel') ?? '').toLowerCase();
    const href = attr('href');
    if (!href || !/\bicon\b|apple-touch-icon/.test(rel) || /mask-icon/.test(rel)) continue;
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, '&'), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const size = Math.max(0, ...(attr('sizes') ?? '').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
    const rank = (rel.includes('apple-touch-icon') ? 180 : 0) + Math.min(size, 256) + (url.pathname.endsWith('.svg') ? 120 : 0);
    found.push({ url, rank });
  }
  return found.sort((a, b) => b.rank - a.rank).map((f) => f.url);
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|ico)$/;

/** Returns the site's icon as a data URL. The browser then resizes it before it's saved. */
export async function fetchSiteIcon(raw: string, fetcher?: IconFetcher): Promise<string> {
  const site = siteUrl(raw);
  const run = fetcher ?? defaultFetcher;
  const check = !fetcher; // injected fetchers (tests) skip DNS
  const candidates: URL[] = [];
  try {
    const { res, url } = await get(site, run, check);
    if (res.ok && (res.headers.get('content-type') ?? '').includes('html')) {
      candidates.push(...iconCandidates((await readLimited(res, MAX_HTML)).toString('utf8'), url));
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) throw err;
    // The page itself may be unreachable while /favicon.ico still works.
  }
  candidates.push(new URL('/apple-touch-icon.png', site), new URL('/favicon.ico', site));

  for (const url of candidates.slice(0, 6)) {
    try {
      const { res } = await get(url, run, check);
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.test(type)) continue;
      const body = await readLimited(res, MAX_ICON);
      if (body.length < 16) continue;
      return `data:${type === 'image/vnd.microsoft.icon' || type === 'image/ico' ? 'image/x-icon' : type};base64,${body.toString('base64')}`;
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) throw err;
    }
  }
  throw new HttpError(404, 'This website doesn’t have an icon Keys can use');
}
