import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Player identity.
 *
 * The requirement is that the client can never name a player. So:
 *
 * - The server mints a random UUID the first time it sees a browser.
 * - That UUID is handed to the browser inside an HttpOnly cookie, together
 *   with an HMAC signature over the value.
 * - On every later request the server verifies the signature before trusting
 *   the id.
 *
 * Why signing matters for this assignment: without it, the game's one truly
 * security-relevant boundary would be a plain cookie. Anyone could set
 * `bpg_player=<another uuid>` and play as another player (reading their score,
 * or burning their single pending prediction). The signature turns that into a
 * forged-cookie rejection.
 *
 * Honest scope note: this is *not* authentication. A player who clears their
 * cookie gets a fresh identity and starts again from zero. Scores are
 * deliberately unattached to any real-world account (see README "Assumptions").
 * The signature prevents impersonating a *specific* existing player; it does
 * not prevent someone from creating their own new ones.
 */

export const PLAYER_COOKIE_NAME = 'bpg_player';

/** One year. Long enough that returning players keep their score. */
export const PLAYER_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Tolerance for a token whose issue time is slightly ahead of our clock. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPlayerId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function sign(playerId: string, issuedAtMs: number, secret: string): string {
  return createHmac('sha256', secret).update(`${playerId}.${issuedAtMs}`).digest('base64url');
}

export function signPlayerToken(playerId: string, issuedAtMs: number, secret: string): string {
  if (!isPlayerId(playerId)) throw new Error('Cannot sign a token for a malformed player id');
  return `${playerId}.${issuedAtMs}.${sign(playerId, issuedAtMs, secret)}`;
}

export function createPlayerToken(
  secret: string,
  now: Date = new Date(),
): { playerId: string; token: string } {
  const playerId = randomUUID();
  return { playerId, token: signPlayerToken(playerId, now.getTime(), secret) };
}

/**
 * @returns the verified player id, or `null` if the token is missing,
 * malformed, expired, from the future, or not correctly signed.
 */
export function verifyPlayerToken(
  token: string | null | undefined,
  secret: string,
  now: Date = new Date(),
  ttlMs: number = PLAYER_TOKEN_TTL_MS,
): { playerId: string; issuedAtMs: number } | null {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [playerId, issuedAtRaw, providedSignature] = parts as [string, string, string];
  if (!isPlayerId(playerId)) return null;

  const issuedAtMs = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) return null;

  const age = now.getTime() - issuedAtMs;
  if (age < -MAX_CLOCK_SKEW_MS) return null;
  if (age > ttlMs) return null;

  const expectedSignature = sign(playerId, issuedAtMs, secret);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  return { playerId, issuedAtMs };
}

/** Minimal cookie header parsing — avoids pulling in a dependency for this. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function playerCookieOptions(secure: boolean, now: Date = new Date()) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge: Math.floor(PLAYER_TOKEN_TTL_MS / 1000),
    expires: new Date(now.getTime() + PLAYER_TOKEN_TTL_MS),
  };
}
