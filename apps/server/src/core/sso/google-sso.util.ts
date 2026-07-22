import { createHmac, timingSafeEqual } from 'node:crypto';

export const GOOGLE_SSO_TRANSACTION_COOKIE = 'google_sso_tx';
export const GOOGLE_SSO_TRANSACTION_TTL_MS = 5 * 60 * 1000;

export type GoogleSsoTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  workspaceId: string;
  returnTo: string;
  issuedAt: number;
};

export function sanitizeReturnTo(value?: string): string {
  if (!value || value.length > 2048) return '/home';
  if (!value.startsWith('/') || value.startsWith('//')) return '/home';
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return '/home';

  try {
    const parsed = new URL(value, 'http://docmost.local');
    if (parsed.origin !== 'http://docmost.local') return '/home';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/home';
  }
}

export function signGoogleSsoTransaction(
  transaction: GoogleSsoTransaction,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(transaction)).toString(
    'base64url',
  );
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyGoogleSsoTransaction(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): GoogleSsoTransaction | null {
  if (!value) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return null;

  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const transaction = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as GoogleSsoTransaction;
    if (
      !transaction.state ||
      !transaction.nonce ||
      !transaction.codeVerifier ||
      !transaction.workspaceId ||
      !Number.isFinite(transaction.issuedAt) ||
      transaction.issuedAt > now + 30_000 ||
      now - transaction.issuedAt > GOOGLE_SSO_TRANSACTION_TTL_MS
    ) {
      return null;
    }
    transaction.returnTo = sanitizeReturnTo(transaction.returnTo);
    return transaction;
  } catch {
    return null;
  }
}
