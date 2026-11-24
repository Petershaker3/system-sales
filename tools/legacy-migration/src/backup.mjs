// The new system's backup envelope, written from the browser.
//
// Layout is `docs/backup-format-v1.md`, and this module follows it byte for
// byte: an 88-byte authenticated prefix, then XChaCha20-Poly1305 over a
// container that holds a JSON manifest and the database file. The prefix is the
// AEAD's associated data, so every declared parameter is authenticated before
// it is believed.
//
// Writing it here rather than in Rust is deliberate: the tool is a single HTML
// file that has to run on the owner's Windows PC with no build chain, and the
// format is small enough to implement exactly once, in one place, with the
// decryption next to the encryption so a test can round-trip it.

import { argon2id } from '@noble/hashes/argon2';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha2';

export const MAGIC = 'MSB1';
export const FORMAT_VERSION = 1;
export const KDF_ARGON2ID = 1;
export const AEAD_XCHACHA20_POLY1305 = 1;
export const SALT_LEN = 32;
export const NONCE_LEN = 24;
export const KEY_LEN = 32;
export const PREFIX_LEN = 88;
export const TAG_LEN = 16;

/** The defaults the app writes (`format.rs`); readers accept 8 MiB…256 MiB. */
export const DEFAULT_KDF = { memoryKib: 64 * 1024, iterations: 3, parallelism: 1 };

export const KDF_BOUNDS = {
  minMemoryKib: 8 * 1024,
  maxMemoryKib: 256 * 1024,
  minIterations: 1,
  maxIterations: 10,
  minParallelism: 1,
  maxParallelism: 4,
};

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Node's webcrypto is the same API; this branch exists for a host with
    // neither, which must fail loudly rather than fall back to Math.random for
    // key material.
    throw new Error('no secure random source');
  }
  return bytes;
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function writeU64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), true);
}

/** Little-endian `u32` length + bytes, the container's manifest frame. */
function frameManifest(manifestBytes) {
  const out = new Uint8Array(4 + manifestBytes.length);
  new DataView(out.buffer).setUint32(0, manifestBytes.length, true);
  out.set(manifestBytes, 4);
  return out;
}

function frameComponent(path, bytes) {
  const pathBytes = utf8ToBytes(path);
  const out = new Uint8Array(2 + pathBytes.length + 8 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, pathBytes.length, true);
  out.set(pathBytes, 2);
  view.setBigUint64(2 + pathBytes.length, BigInt(bytes.length), true);
  out.set(bytes, 2 + pathBytes.length + 8);
  return out;
}

function concat(parts) {
  const total = parts.reduce((length, part) => length + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Build a `.msb1` file from database bytes.
 *
 * `images` are `{ path: 'images/...', bytes }`; the shop logo is
 * `images/shop-logo.jpg`, which is exactly the path the app reads it from.
 */
export function buildBackupFile({ dbBytes, password, images = [], createdAt = Date.now(), kdf = DEFAULT_KDF, salt, nonce }) {
  if (!password || password.length < 8) {
    throw new Error('كلمة سر النسخة لازم 8 حروف أو أكتر (زي ما التطبيق بيطلب).');
  }
  const memoryKib = kdf.memoryKib ?? DEFAULT_KDF.memoryKib;
  const iterations = kdf.iterations ?? DEFAULT_KDF.iterations;
  const parallelism = kdf.parallelism ?? DEFAULT_KDF.parallelism;
  if (
    memoryKib < KDF_BOUNDS.minMemoryKib || memoryKib > KDF_BOUNDS.maxMemoryKib
    || iterations < KDF_BOUNDS.minIterations || iterations > KDF_BOUNDS.maxIterations
    || parallelism < KDF_BOUNDS.minParallelism || parallelism > KDF_BOUNDS.maxParallelism
  ) {
    throw new Error('إعدادات تقوية التشفير خارج الحدود اللي التطبيق بيقبلها.');
  }

  const saltBytes = salt || randomBytes(SALT_LEN);
  const nonceBytes = nonce || randomBytes(NONCE_LEN);

  const components = [
    { path: 'shop.db', bytes: dbBytes },
    ...images.filter((image) => image.bytes && image.bytes.length > 0),
  ];

  const manifest = {
    format_version: FORMAT_VERSION,
    created_at_unix_ms: createdAt,
    database: {
      path: 'shop.db',
      len: dbBytes.length,
      sha256: bytesToHex(sha256(dbBytes)),
    },
    images: components.slice(1).map((component) => ({
      path: component.path,
      len: component.bytes.length,
      sha256: bytesToHex(sha256(component.bytes)),
    })),
    uncompressed_len: components.reduce((total, component) => total + component.bytes.length, 0),
  };

  const manifestBytes = utf8ToBytes(JSON.stringify(manifest));
  const container = concat([
    frameManifest(manifestBytes),
    ...components.map((component) => frameComponent(component.path, component.bytes)),
  ]);

  const prefix = new Uint8Array(PREFIX_LEN);
  const view = new DataView(prefix.buffer);
  prefix.set(utf8ToBytes(MAGIC), 0);
  writeU16(view, 4, FORMAT_VERSION);
  view.setUint8(6, KDF_ARGON2ID);
  view.setUint8(7, AEAD_XCHACHA20_POLY1305);
  writeU32(view, 8, memoryKib);
  writeU32(view, 12, iterations);
  writeU32(view, 16, parallelism);
  view.setUint8(20, SALT_LEN);
  view.setUint8(21, NONCE_LEN);
  writeU16(view, 22, 0);
  // payload_len is the ciphertext *including* the 16-byte tag, so a reader never
  // adds or subtracts a tag length to check the file size.
  writeU64(view, 24, container.length + TAG_LEN);
  prefix.set(saltBytes, 32);
  prefix.set(nonceBytes, 64);

  const key = argon2id(utf8ToBytes(password), saltBytes, {
    m: memoryKib,
    t: iterations,
    p: parallelism,
    dkLen: KEY_LEN,
  });
  const cipher = xchacha20poly1305(key, nonceBytes, prefix);
  const ciphertext = cipher.encrypt(container);

  return {
    bytes: concat([prefix, ciphertext]),
    manifest,
    kdf: { memoryKib, iterations, parallelism },
  };
}

/**
 * Read a `.msb1` file back. Used by the tool's own self-check and by the tests;
 * the app's Rust reader is the authority, and the Python verification script
 * under `verify/` checks the same bytes with independent libraries.
 */
export function readBackupFile(bytes, password) {
  if (bytes.length < PREFIX_LEN + TAG_LEN) throw new Error('الملف أقصر من إنه يكون نسخة.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error('الملف مش نسخة احتياطية للسيستم الجديد.');
  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) throw new Error(`نسخة غير مدعومة: ${version}`);
  const kdfId = view.getUint8(6);
  const aeadId = view.getUint8(7);
  if (kdfId !== KDF_ARGON2ID || aeadId !== AEAD_XCHACHA20_POLY1305) {
    throw new Error('خوارزمية تشفير غير مدعومة.');
  }
  const memoryKib = view.getUint32(8, true);
  const iterations = view.getUint32(12, true);
  const parallelism = view.getUint32(16, true);
  const saltLen = view.getUint8(20);
  const nonceLen = view.getUint8(21);
  if (saltLen !== SALT_LEN || nonceLen !== NONCE_LEN) throw new Error('ترويسة غير صالحة.');
  const payloadLen = Number(view.getBigUint64(24, true));
  if (bytes.length !== PREFIX_LEN + payloadLen) throw new Error('حجم الملف مش مطابق للترويسة.');

  const prefix = bytes.subarray(0, PREFIX_LEN);
  const salt = bytes.subarray(32, 64);
  const nonce = bytes.subarray(64, 88);
  const key = argon2id(utf8ToBytes(password), salt, { m: memoryKib, t: iterations, p: parallelism, dkLen: KEY_LEN });
  const container = xchacha20poly1305(key, nonce, prefix).decrypt(bytes.subarray(PREFIX_LEN));

  const manifestLen = new DataView(container.buffer, container.byteOffset).getUint32(0, true);
  const manifest = JSON.parse(new TextDecoder().decode(container.subarray(4, 4 + manifestLen)));
  const entries = new Map();
  let offset = 4 + manifestLen;
  while (offset < container.length) {
    const pathLen = new DataView(container.buffer, container.byteOffset).getUint16(offset, true);
    offset += 2;
    const path = new TextDecoder().decode(container.subarray(offset, offset + pathLen));
    offset += pathLen;
    const dataLen = Number(new DataView(container.buffer, container.byteOffset).getBigUint64(offset, true));
    offset += 8;
    entries.set(path, container.subarray(offset, offset + dataLen));
    offset += dataLen;
  }
  const database = entries.get('shop.db');
  if (!database) throw new Error('النسخة مفيهاش قاعدة البيانات.');
  if (bytesToHex(sha256(database)) !== manifest.database.sha256) throw new Error('بصمة قاعدة البيانات مش مطابقة.');
  return { manifest, database, images: [...entries.entries()].filter(([path]) => path !== 'shop.db') };
}
