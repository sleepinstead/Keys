import type { NextFunction, Request, Response } from 'express';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const API_HEADER = 'x-keys-request';
/** Carries the session token. Not a cookie: browsers share cookies with every other app on localhost, whatever its port. */
export const SESSION_HEADER = 'x-keys-session';

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/** Defensive headers for every response. The CSP forbids inline scripts and all third-party origins. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
}

/** Blocks DNS-rebinding: the Host header must be a loopback name. */
export function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
  const host = hostnameOf(req.headers.host);
  if (!host || !LOCAL_HOSTNAMES.has(host)) {
    res.status(421).type('text/plain').send('Keys only answers on localhost');
    return;
  }
  next();
}

/**
 * CSRF / cross-origin protection for the API, on top of the session header:
 *  - a custom header is required (cross-origin pages can't send it without a CORS preflight, which we never grant);
 *  - Origin, when sent, must be one of our exact origins (blocks other apps on other localhost ports);
 *  - Sec-Fetch-Site, when sent, must be same-origin.
 */
export function apiGuard(allowedOrigins: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      return;
    }
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (req.headers[API_HEADER] !== '1' || (origin && !allowedOrigins.has(origin)) || (site && site !== 'same-origin')) {
      res.status(403).json({ error: 'Request blocked', code: 'FORBIDDEN' });
      return;
    }
    next();
  };
}
