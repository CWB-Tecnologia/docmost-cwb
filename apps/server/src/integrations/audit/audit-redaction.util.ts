const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'privatekey',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive));
}

/**
 * Return a JSON-safe copy with credentials removed before they enter the
 * durable audit log. Audit payloads are expected to be plain data; circular
 * references are replaced instead of making the business operation fail.
 */
export function redactAuditValue<T>(value: T): T {
  const seen = new WeakSet<object>();

  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (current instanceof Date) return current.toISOString();
    if (!current || typeof current !== 'object') return current;

    if (seen.has(current)) return '[CIRCULAR]';
    seen.add(current);

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      current as Record<string, unknown>,
    )) {
      output[key] = isSensitiveKey(key) ? REDACTED : visit(nested);
    }
    seen.delete(current);
    return output;
  };

  return visit(value) as T;
}

export { REDACTED as AUDIT_REDACTED_VALUE };
