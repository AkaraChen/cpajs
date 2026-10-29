const MIN_SECRET_LENGTH = 4;

/** Replaces every occurrence of the given secrets with `[REDACTED]`. */
export function createRedactor(secrets: Iterable<string | undefined>): (text: string) => string {
  const values = [...new Set([...secrets].filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH))]
    // Longest first so a secret containing another one is fully masked.
    .sort((a, b) => b.length - a.length);
  if (values.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const value of values) out = out.split(value).join('[REDACTED]');
    return out;
  };
}
