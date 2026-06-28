// ── Tiny ES5-compatible array/object helpers ────────────────
// Avoids dependency on ES2017+ features for TS strict-mode compat.

export function toArray<T>(obj: Record<string, T>): T[] {
  const result: T[] = [];
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    result.push(obj[keys[i]]);
  }
  return result;
}

export function includes<T>(arr: T[], val: T): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === val) return true;
  }
  return false;
}

export function filterMapValues<K extends string, V, R>(
  obj: Record<K, V>,
  fn: (val: V, key: K) => R | undefined,
): R[] {
  const result: R[] = [];
  const keys = Object.keys(obj) as K[];
  for (let i = 0; i < keys.length; i++) {
    const r = fn(obj[keys[i]], keys[i]);
    if (r !== undefined) result.push(r);
  }
  return result;
}
