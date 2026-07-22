import { AUDIT_REDACTED_VALUE, redactAuditValue } from './audit-redaction.util';

describe('redactAuditValue', () => {
  it('redacts credentials recursively while preserving useful fields', () => {
    const result = redactAuditValue({
      email: 'person@example.com',
      password: 'plaintext',
      nested: {
        client_secret: 'secret',
        accessToken: 'token',
        role: 'owner',
      },
      headers: [{ Authorization: 'Bearer token', accept: 'json' }],
    });

    expect(result).toEqual({
      email: 'person@example.com',
      password: AUDIT_REDACTED_VALUE,
      nested: {
        client_secret: AUDIT_REDACTED_VALUE,
        accessToken: AUDIT_REDACTED_VALUE,
        role: 'owner',
      },
      headers: [{ Authorization: AUDIT_REDACTED_VALUE, accept: 'json' }],
    });
  });

  it('replaces circular references instead of throwing', () => {
    const value: Record<string, unknown> = { name: 'audit' };
    value.self = value;

    expect(redactAuditValue(value)).toEqual({
      name: 'audit',
      self: '[CIRCULAR]',
    });
  });
});
