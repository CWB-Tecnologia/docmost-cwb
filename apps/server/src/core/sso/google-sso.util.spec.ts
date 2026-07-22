import {
  GOOGLE_SSO_TRANSACTION_TTL_MS,
  GoogleSsoTransaction,
  sanitizeReturnTo,
  signGoogleSsoTransaction,
  verifyGoogleSsoTransaction,
} from './google-sso.util';

describe('Google SSO utilities', () => {
  const secret = 'a'.repeat(32);
  const now = Date.now();
  const transaction: GoogleSsoTransaction = {
    state: 'state',
    nonce: 'nonce',
    codeVerifier: 'verifier',
    workspaceId: 'workspace-id',
    returnTo: '/s/support/boards?view=open',
    issuedAt: now,
  };

  it('round-trips a signed transaction', () => {
    const cookie = signGoogleSsoTransaction(transaction, secret);
    expect(verifyGoogleSsoTransaction(cookie, secret, now)).toEqual(
      transaction,
    );
  });

  it('rejects tampered and expired transactions', () => {
    const cookie = signGoogleSsoTransaction(transaction, secret);
    expect(verifyGoogleSsoTransaction(`${cookie}x`, secret, now)).toBeNull();
    expect(
      verifyGoogleSsoTransaction(
        cookie,
        secret,
        now + GOOGLE_SSO_TRANSACTION_TTL_MS + 1,
      ),
    ).toBeNull();
  });

  it.each([
    ['https://evil.example', '/home'],
    ['//evil.example/path', '/home'],
    ['/safe\\evil', '/home'],
    ['/safe path', '/home'],
    ['/safe?next=%2Fhome', '/safe?next=%2Fhome'],
  ])('sanitizes return path %s', (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });
});
