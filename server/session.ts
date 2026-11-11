import { randomToken, safeEqual } from './crypto.ts';

/**
 * Holds the decrypted vault key in memory for exactly one session.
 * The key is zeroed on lock, idle timeout, or process exit; it never touches disk.
 */
export class SessionManager {
  private key: Buffer | null = null;
  private token: string | null = null;
  private lastActivity = 0;
  private readonly idleMs: () => number;
  private readonly timer: NodeJS.Timeout;
  private readonly listeners = new Set<() => void>();

  constructor(idleMs: () => number) {
    this.idleMs = idleMs;
    this.timer = setInterval(() => this.expireIfIdle(), 1000);
    this.timer.unref();
  }

  /** Starts a new session, replacing (and invalidating) any existing one. */
  open(key: Buffer): string {
    this.lock();
    this.key = key;
    this.token = randomToken();
    this.lastActivity = Date.now();
    return this.token;
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** Returns the vault key if `token` is the live session. Optionally counts as activity. */
  authorize(token: string | undefined, touch = true): Buffer | null {
    this.expireIfIdle();
    if (!this.key || !this.token || !token || !safeEqual(token, this.token)) return null;
    if (touch) this.lastActivity = Date.now();
    return this.key;
  }

  /**
   * The vault key while Keys is unlocked, for the browser extension (which has no session token
   * of its own). Optionally counts as activity.
   */
  peek(touch: boolean): Buffer | null {
    this.expireIfIdle();
    if (!this.key) return null;
    if (touch) this.lastActivity = Date.now();
    return this.key;
  }

  expiresAt(): number | null {
    return this.key ? this.lastActivity + this.idleMs() : null;
  }

  lock(): void {
    if (this.key) this.key.fill(0);
    const wasUnlocked = this.key !== null;
    this.key = null;
    this.token = null;
    if (wasUnlocked) for (const fn of this.listeners) fn();
  }

  onLock(fn: () => void): void {
    this.listeners.add(fn);
  }

  private expireIfIdle(): void {
    if (!this.key) return;
    try {
      if (Date.now() - this.lastActivity < this.idleMs()) return;
    } catch {
      /* the database became unreachable (a removed drive, say): lock rather than crash in a timer */
    }
    this.lock();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.lock();
  }
}
