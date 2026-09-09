/**
 * Deterministic non-cryptographic hash.
 *
 * Adequate for the mock backend: it exists so that no seeded password or
 * verification code sits in AsyncStorage in the clear, and so the auth code
 * already has the right shape for a real one. The production system uses
 * Supabase Auth's bcrypt - this is never the thing protecting an account.
 *
 * Lives in its own module so `db.ts` and `seed.ts` can both use it without
 * importing each other, which would create a require cycle and risk one of them
 * seeing an uninitialised value at startup.
 */
export function hashSecret(value: string, salt = 'sra'): string {
  const input = `${salt}:${value}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
