import { describe, expect, it } from 'vitest';
import {
  createPlayerToken,
  isPlayerId,
  PLAYER_COOKIE_NAME,
  readCookie,
  serializePlayerCookie,
  signPlayerToken,
  verifyPlayerToken,
} from '@/server/identity';

/**
 * Identity tests.
 *
 * The property that matters for the assignment: a client cannot name a player.
 * Everything below is about making a forged or replayed cookie fail closed.
 */
const SECRET = 'test-secret-value-that-is-long-enough-1234';
const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('player tokens', () => {
  it('round-trips a freshly issued token', () => {
    const { playerId, token } = createPlayerToken(SECRET, NOW);
    expect(verifyPlayerToken(token, SECRET, NOW)).toEqual({ playerId, issuedAtMs: NOW.getTime() });
  });

  it('issues a random id each time', () => {
    const a = createPlayerToken(SECRET, NOW);
    const b = createPlayerToken(SECRET, NOW);
    expect(a.playerId).not.toBe(b.playerId);
  });

  it('rejects a token whose player id has been swapped', () => {
    const { token } = createPlayerToken(SECRET, NOW);
    const other = createPlayerToken(SECRET, NOW);
    const [, issuedAt, signature] = token.split('.');
    // Attacker rewrites the id but cannot produce a matching signature.
    const forged = `${other.playerId}.${issuedAt}.${signature}`;
    expect(verifyPlayerToken(forged, SECRET, NOW)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const { playerId } = createPlayerToken(SECRET, NOW);
    const foreign = signPlayerToken(playerId, NOW.getTime(), 'a-different-secret-that-is-long-enough');
    expect(verifyPlayerToken(foreign, SECRET, NOW)).toBeNull();
  });

  it('rejects a truncated signature', () => {
    const { playerId } = createPlayerToken(SECRET, NOW);
    expect(verifyPlayerToken(`${playerId}.${NOW.getTime()}.abc`, SECRET, NOW)).toBeNull();
  });

  it('rejects an expired token', () => {
    const { token } = createPlayerToken(SECRET, NOW);
    const longAfter = new Date(NOW.getTime() + 366 * 24 * 60 * 60 * 1000);
    expect(verifyPlayerToken(token, SECRET, longAfter)).toBeNull();
  });

  it('rejects a token dated implausibly far in the future', () => {
    const { playerId } = createPlayerToken(SECRET, NOW);
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);
    const token = signPlayerToken(playerId, future.getTime(), SECRET);
    expect(verifyPlayerToken(token, SECRET, NOW)).toBeNull();
  });

  it('tolerates a small clock difference', () => {
    const { playerId } = createPlayerToken(SECRET, NOW);
    const slightlyAhead = new Date(NOW.getTime() + 30_000);
    const token = signPlayerToken(playerId, slightlyAhead.getTime(), SECRET);
    expect(verifyPlayerToken(token, SECRET, NOW)?.playerId).toBe(playerId);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['not-a-token'],
    ['a.b'],
    ['a.b.c.d'],
  ])('rejects malformed token %s', (token) => {
    expect(verifyPlayerToken(token as string, SECRET, NOW)).toBeNull();
  });

  it('refuses to sign a non-uuid player id', () => {
    // Guards against a caller accidentally minting a token for an
    // attacker-controlled string such as an email address or SQL fragment.
    expect(() => signPlayerToken('player-1', NOW.getTime(), SECRET)).toThrow(/malformed player id/);
  });

  it('recognises uuid-shaped ids only', () => {
    expect(isPlayerId('2c9a1f0e-4b1d-4c3f-9c1e-8f2b6a7d5e40')).toBe(true);
    expect(isPlayerId('2c9a1f0e-4b1d-4c3f-9c1e-8f2b6a7d5e4')).toBe(false);
    expect(isPlayerId('admin')).toBe(false);
  });
});

describe('readCookie', () => {
  it('finds the player cookie among other cookies', () => {
    const header = `theme=dark; ${PLAYER_COOKIE_NAME}=abc123; other=1`;
    expect(readCookie(header, PLAYER_COOKIE_NAME)).toBe('abc123');
  });

  it('url-decodes the value', () => {
    expect(readCookie(`${PLAYER_COOKIE_NAME}=a%2Eb`, PLAYER_COOKIE_NAME)).toBe('a.b');
  });

  it('treats invalid percent-encoding as a malformed cookie', () => {
    expect(readCookie(`${PLAYER_COOKIE_NAME}=%E0%A4%A`, PLAYER_COOKIE_NAME)).toBeNull();
  });

  it('returns null when absent', () => {
    expect(readCookie('theme=dark', PLAYER_COOKIE_NAME)).toBeNull();
    expect(readCookie(null, PLAYER_COOKIE_NAME)).toBeNull();
  });

  it('does not confuse similarly named cookies', () => {
    expect(readCookie(`not_${PLAYER_COOKIE_NAME}=x`, PLAYER_COOKIE_NAME)).toBeNull();
  });
});

describe('serializePlayerCookie', () => {
  const token = 'abc.def.ghi';

  it('always sets HttpOnly, Path and a SameSite policy', () => {
    const cookie = serializePlayerCookie(token, { secure: false });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=');
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure when configured', () => {
    expect(serializePlayerCookie(token, { secure: true })).toContain('; Secure');
  });

  it('supports SameSite=None for iframe-embedded deployments', () => {
    // Lax cookies are dropped when the app runs inside a third-party iframe,
    // which would silently break player identity in an embedded preview.
    const cookie = serializePlayerCookie(token, { secure: true, sameSite: 'None' });
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
  });
});
