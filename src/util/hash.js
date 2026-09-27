// Fast non-cryptographic hashes for stable IDs and de-duplication.

/** cyrb53: 53-bit string hash with good distribution. */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashString(str, seed = 0) {
  return cyrb53(str, seed).toString(36);
}

/** Hash for binary data. Samples large buffers (head, tail and strided middle) for speed. */
export function hashBytes(bytes) {
  let h1 = 0x811c9dc5 ^ bytes.length;
  let h2 = 0x01000193;
  const n = bytes.length;
  const step = n > 262144 ? Math.floor(n / 65536) : 1;
  for (let i = 0; i < n; i += step) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 16777619);
    h2 = Math.imul(h2 ^ b, 2654435761);
  }
  if (step > 1) {
    const tail = Math.max(0, n - 4096);
    for (let i = tail; i < n; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 16777619);
    }
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + n.toString(36));
}

/** Deterministic integer seed from a string. */
export function seedFrom(str) {
  return cyrb53(str) >>> 0;
}

let counter = 0;
export function uid(prefix = 'id') {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
