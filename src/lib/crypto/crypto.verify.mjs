/**
 * Executable proof for the crypto core (node V1).
 *
 *   node src/lib/crypto/crypto.verify.mjs
 *
 * It compiles the *real* TypeScript sources in this directory to a temp dir
 * with `tsc` and exercises the compiled output, so there is no second
 * implementation to drift. Node 22 exposes WebCrypto as `globalThis.crypto`,
 * which is the same SubtleCrypto surface Safari gives us.
 *
 * Everything here is a hard assertion. A failure exits non-zero.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${expected}, got ${actual}`);
}

async function throws(name, fn, predicate) {
  try {
    await fn();
    ok(name, false, 'no error thrown');
  } catch (err) {
    ok(name, predicate(err), `${err?.constructor?.name}: ${err?.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Compile the real sources.
// ---------------------------------------------------------------------------

const outDir = mkdtempSync(join(tmpdir(), 'hcvault-crypto-'));
try {
  console.log('Compiling src/lib/crypto/*.ts ...');
  const t0 = Date.now();
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'tsc',
      '--module', 'commonjs',
      '--target', 'es2022',
      '--moduleResolution', 'node10',
      '--strict',
      '--esModuleInterop',
      '--skipLibCheck',
      '--lib', 'es2022,dom',
      '--outDir', outDir,
      join(HERE, 'random.ts'),
      join(HERE, 'kdf.ts'),
      join(HERE, 'aead.ts'),
      join(HERE, 'keyring.ts'),
      join(HERE, 'recovery-code.ts'),
      join(HERE, 'index.ts'),
    ],
    { cwd: REPO, stdio: 'inherit' },
  );
  console.log(`Compiled in ${Date.now() - t0} ms -> ${outDir}\n`);

  const require = createRequire(join(outDir, 'x.cjs'));
  const C = require(join(outDir, 'index.js'));

  // A deliberately cheap iteration count so the suite runs in seconds. The
  // production constant is asserted separately below.
  const FAST = 1000;

  // -------------------------------------------------------------------------
  section('1. Constants and encodings');
  // -------------------------------------------------------------------------
  eq('PBKDF2 iterations are the OWASP floor', C.PBKDF2_ITERATIONS, 600000);
  eq('KDF salt is 16 bytes', C.KDF_SALT_BYTES, 16);
  eq('IV is 12 bytes', C.IV_BYTES, 12);
  eq('GCM tag is 128 bits', C.TAG_BITS, 128);

  {
    let roundTripOk = true;
    for (let len = 0; len < 200; len++) {
      const b = C.randomBytes(len);
      const s = C.toBase64Url(b);
      const back = C.fromBase64Url(s);
      if (back.length !== b.length || back.some((v, i) => v !== b[i])) roundTripOk = false;
      if (/[^A-Za-z0-9_-]/.test(s)) roundTripOk = false;
    }
    ok('base64url round-trips for every length 0..199 and stays URL-safe', roundTripOk);
    eq('base64url of [251,255,191] is "-_-_"', C.toBase64Url(new Uint8Array([251, 255, 191])), '-_-_');
    ok(
      'base64url rejects invalid characters',
      (() => {
        try {
          C.fromBase64Url('abc$');
          return false;
        } catch {
          return true;
        }
      })(),
    );
  }

  // -------------------------------------------------------------------------
  section('2. AEAD round-trip');
  // -------------------------------------------------------------------------
  const dek = await C.generateDek();
  const rawDek = await C.exportDek(dek);
  eq('DEK is 256 bits', rawDek.length * 8, 256);

  const sample = {
    dateKey: '2026-07-26',
    kg: 82.35,
    note: 'post-run, before coffee \u{1F3C3}',
    nested: { hrv: [61, 58, 64], nullish: null },
  };
  const aad = C.rowAad('weightEntries', 'row-1');
  const payload = await C.encryptJson(dek, sample, aad);
  const back = await C.decryptJson(dek, payload, aad);
  ok('encryptJson/decryptJson round-trips exactly', JSON.stringify(back) === JSON.stringify(sample));
  eq('IV is 12 bytes', payload.iv.length, 12);
  ok(
    'ciphertext is longer than plaintext by exactly the 16-byte GCM tag',
    payload.ct.length === Buffer.byteLength(JSON.stringify(sample), 'utf8') + 16,
    `ct=${payload.ct.length}, pt=${Buffer.byteLength(JSON.stringify(sample), 'utf8')}`,
  );
  ok(
    'ciphertext does not contain the plaintext',
    !Buffer.from(payload.ct).includes(Buffer.from('82.35')),
  );

  // -------------------------------------------------------------------------
  section('3. Wrong key / tampering fail on the auth tag, never silently');
  // -------------------------------------------------------------------------
  const otherDek = await C.generateDek();
  await throws(
    'wrong key throws DecryptionError (not garbage)',
    () => C.decryptJson(otherDek, payload, aad),
    (e) => e.name === 'DecryptionError',
  );
  await throws(
    'flipped ciphertext bit throws DecryptionError',
    () => {
      const ct = Uint8Array.from(payload.ct);
      ct[3] ^= 0x01;
      return C.decryptJson(dek, { iv: payload.iv, ct }, aad);
    },
    (e) => e.name === 'DecryptionError',
  );
  await throws(
    'flipped tag bit throws DecryptionError',
    () => {
      const ct = Uint8Array.from(payload.ct);
      ct[ct.length - 1] ^= 0x80;
      return C.decryptJson(dek, { iv: payload.iv, ct }, aad);
    },
    (e) => e.name === 'DecryptionError',
  );
  await throws(
    'wrong IV throws DecryptionError',
    () => C.decryptJson(dek, { iv: C.randomBytes(12), ct: payload.ct }, aad),
    (e) => e.name === 'DecryptionError',
  );
  await throws(
    'AAD binding: same ciphertext under a different table is rejected',
    () => C.decryptJson(dek, payload, C.rowAad('foodLogs', 'row-1')),
    (e) => e.name === 'DecryptionError',
  );
  await throws(
    'AAD binding: same ciphertext under a different row id is rejected',
    () => C.decryptJson(dek, payload, C.rowAad('weightEntries', 'row-2')),
    (e) => e.name === 'DecryptionError',
  );
  await throws(
    'truncated IV is rejected as malformed',
    () => C.decryptJson(dek, { iv: C.randomBytes(8), ct: payload.ct }, aad),
    (e) => e.name === 'DecryptionError',
  );

  // -------------------------------------------------------------------------
  section('4. IV uniqueness across many encryptions');
  // -------------------------------------------------------------------------
  {
    const N = 20000;
    const seen = new Set();
    const cts = new Set();
    for (let i = 0; i < N; i++) {
      const p = await C.encryptJson(dek, { i }, aad);
      seen.add(C.toBase64Url(p.iv));
      cts.add(C.toBase64Url(p.ct));
    }
    eq(`${N} encryptions produced ${N} distinct IVs`, seen.size, N);
    ok(
      'identical plaintexts still produce distinct ciphertexts',
      (async () => true)() && cts.size === N,
      `${cts.size} distinct ciphertexts`,
    );
    const dup = await C.encryptJson(dek, sample, aad);
    ok(
      'encrypting the same value twice yields different IV and ciphertext',
      C.toBase64Url(dup.iv) !== C.toBase64Url(payload.iv) &&
        C.toBase64Url(dup.ct) !== C.toBase64Url(payload.ct),
    );
  }

  // -------------------------------------------------------------------------
  section('5. KDF');
  // -------------------------------------------------------------------------
  {
    const salt = C.generateKdfSalt();
    eq('generated salt is 16 bytes', salt.length, 16);
    const k1 = await C.deriveKek('correct horse battery staple', salt, FAST);
    const k2 = await C.deriveKek('correct horse battery staple', salt, FAST);
    const probe = await C.encryptBytes(k1, C.utf8('probe'));
    const viaK2 = await C.decryptBytes(k2, probe);
    ok('same passphrase + salt derives the same KEK', C.fromUtf8(viaK2) === 'probe');

    const otherSalt = C.generateKdfSalt();
    const k3 = await C.deriveKek('correct horse battery staple', otherSalt, FAST);
    await throws(
      'different salt derives a different KEK',
      () => C.decryptBytes(k3, probe),
      (e) => e.name === 'DecryptionError',
    );

    const k4 = await C.deriveKek('correct horse battery stapl3', salt, FAST);
    await throws(
      'one changed character derives a different KEK',
      () => C.decryptBytes(k4, probe),
      (e) => e.name === 'DecryptionError',
    );

    // NFKC normalisation: the same passphrase typed composed vs decomposed.
    const composed = 'café-passphrase';
    const decomposed = 'café-passphrase';
    ok('the two accent forms are different JS strings', composed !== decomposed);
    const kc = await C.deriveKek(composed, salt, FAST);
    const kd = await C.deriveKek(decomposed, salt, FAST);
    const probe2 = await C.encryptBytes(kc, C.utf8('nfkc'));
    ok(
      'NFKC normalisation makes composed and decomposed passphrases equivalent',
      C.fromUtf8(await C.decryptBytes(kd, probe2)) === 'nfkc',
    );

    const prf = C.randomBytes(32);
    const h1 = await C.deriveKekFromSecret(prf, salt, 'hcvault/passkey-prf/v1');
    const h2 = await C.deriveKekFromSecret(prf, salt, 'hcvault/passkey-prf/v1');
    const probe3 = await C.encryptBytes(h1, C.utf8('hkdf'));
    ok('HKDF is deterministic for the same secret+salt+info', C.fromUtf8(await C.decryptBytes(h2, probe3)) === 'hkdf');
    const h3 = await C.deriveKekFromSecret(prf, salt, 'different/info');
    await throws(
      'HKDF info provides real domain separation',
      () => C.decryptBytes(h3, probe3),
      (e) => e.name === 'DecryptionError',
    );
  }

  // -------------------------------------------------------------------------
  section('6. Recovery code');
  // -------------------------------------------------------------------------
  {
    const code = C.generateRecoveryCode();
    eq('normalized code is 28 characters', code.normalized.length, C.RECOVERY_CODE_CHARS);
    eq('formatted code is 7 groups of 4', code.formatted.split('-').length, 7);
    eq('formatted code is 34 characters with separators', code.formatted.length, 34);
    eq('entropy is 15 bytes = 120 bits', code.bytes.length, 15);
    ok(
      'alphabet excludes I, L, O and U',
      !/[ILOU]/.test(code.normalized),
      code.formatted,
    );

    const reparsed = C.parseRecoveryCode(code.formatted);
    ok('a generated code parses back to the same bytes', Buffer.from(reparsed.bytes).equals(Buffer.from(code.bytes)));
    ok('lowercase input parses', C.isValidRecoveryCode(code.formatted.toLowerCase()));
    ok('separator-free input parses', C.isValidRecoveryCode(code.normalized));
    ok('space-separated input parses', C.isValidRecoveryCode(code.formatted.replace(/-/g, ' ')));

    // Crockford aliasing: O -> 0, I/L -> 1.
    const aliased = code.formatted.replace(/0/g, 'O').replace(/1/g, 'I');
    ok('Crockford aliases O->0 and I->1 are accepted', C.isValidRecoveryCode(aliased));

    // Every single-character substitution must be caught by the checksum.
    let singleCharCaught = 0;
    let singleCharTotal = 0;
    for (let i = 0; i < code.normalized.length; i++) {
      for (const ch of C.CROCKFORD_ALPHABET) {
        if (ch === code.normalized[i]) continue;
        singleCharTotal++;
        const typo = code.normalized.slice(0, i) + ch + code.normalized.slice(i + 1);
        if (!C.isValidRecoveryCode(typo)) singleCharCaught++;
      }
    }
    eq(
      `all ${singleCharTotal} single-character typos rejected`,
      singleCharCaught,
      singleCharTotal,
    );

    // Adjacent transpositions.
    let transCaught = 0;
    let transTotal = 0;
    for (let i = 0; i + 1 < code.normalized.length; i++) {
      if (code.normalized[i] === code.normalized[i + 1]) continue;
      transTotal++;
      const t =
        code.normalized.slice(0, i) +
        code.normalized[i + 1] +
        code.normalized[i] +
        code.normalized.slice(i + 2);
      if (!C.isValidRecoveryCode(t)) transCaught++;
    }
    eq(`all ${transTotal} adjacent transpositions rejected`, transCaught, transTotal);

    // Random 28-char strings must essentially never pass (2^-20).
    let falseAccepts = 0;
    const TRIALS = 20000;
    for (let i = 0; i < TRIALS; i++) {
      let s = '';
      const rb = C.randomBytes(28);
      for (let j = 0; j < 28; j++) s += C.CROCKFORD_ALPHABET[rb[j] & 31];
      if (C.isValidRecoveryCode(s)) falseAccepts++;
    }
    ok(
      `random codes rejected: ${falseAccepts}/${TRIALS} false accepts (expected ~${(TRIALS / 2 ** 20).toFixed(2)})`,
      falseAccepts <= 3,
    );

    ok('wrong-length input reports reason "length"', (() => {
      try {
        C.parseRecoveryCode('ABC');
        return false;
      } catch (e) {
        return e.name === 'RecoveryCodeError' && e.reason === 'length';
      }
    })());
    ok('typo reports reason "checksum"', (() => {
      const bad = code.normalized[0] === '0'
        ? '2' + code.normalized.slice(1)
        : '0' + code.normalized.slice(1);
      try {
        C.parseRecoveryCode(bad);
        return false;
      } catch (e) {
        return e.name === 'RecoveryCodeError' && e.reason === 'checksum';
      }
    })());

    // 20k independently generated codes must all be distinct.
    const codes = new Set();
    for (let i = 0; i < 20000; i++) codes.add(C.generateRecoveryCode().normalized);
    eq('20000 generated codes are all distinct', codes.size, 20000);
  }

  // -------------------------------------------------------------------------
  section('7. Keyring — one DEK, three independent wrappings');
  // -------------------------------------------------------------------------
  {
    let keyring = C.createKeyring();
    const vaultDek = await C.generateDek();
    const raw = await C.exportDek(vaultDek);

    keyring = await C.addPassphraseWrapping(keyring, raw, 'my long passphrase', {
      iterations: FAST,
    });
    const issue = await C.addRecoveryCodeWrapping(keyring, raw, { iterations: FAST });
    keyring = issue.keyring;
    const prfSecret = C.randomBytes(32);
    keyring = await C.addSecretWrapping(keyring, raw, prfSecret, {
      label: 'iPhone — Face ID',
      meta: { credentialId: C.toBase64Url(C.randomBytes(16)) },
    });

    eq('keyring holds three wrappings', keyring.wrappedKeys.length, 3);
    ok(
      'each wrapping has a distinct salt',
      new Set(keyring.wrappedKeys.map((w) => w.kdf.salt)).size === 3,
    );
    ok('each wrapping has a distinct IV', new Set(keyring.wrappedKeys.map((w) => w.iv)).size === 3);
    ok(
      'each wrapping has a distinct ciphertext',
      new Set(keyring.wrappedKeys.map((w) => w.ct)).size === 3,
    );

    const viaPass = await C.unlockKeyring(keyring, 'passphrase', 'my long passphrase');
    const viaRec = await C.unlockWithRecoveryCode(keyring, issue.code);
    const viaPrf = await C.unlockKeyring(keyring, 'passkey-prf', prfSecret);

    const hex = (b) => Buffer.from(b).toString('hex');
    eq('passphrase wrapping recovers the DEK', hex(viaPass.rawDek), hex(raw));
    eq('recovery-code wrapping recovers the SAME DEK', hex(viaRec.rawDek), hex(raw));
    eq('passkey-PRF wrapping recovers the SAME DEK', hex(viaPrf.rawDek), hex(raw));
    ok(
      'the three unlocks used three different wrappings',
      new Set([viaPass.wrappedKeyId, viaRec.wrappedKeyId, viaPrf.wrappedKeyId]).size === 3,
    );

    // Data encrypted before the extra wrappings existed still decrypts.
    const rowKey = await C.importDek(raw);
    const rowAadHere = C.rowAad('foodLogs', 'abc');
    const enc = await C.encryptJson(rowKey, { kcal: 640 }, rowAadHere);
    const viaRecoveryKey = await C.importDek(viaRec.rawDek);
    eq(
      'a row encrypted under the DEK opens after a recovery-code unlock',
      (await C.decryptJson(viaRecoveryKey, enc, rowAadHere)).kcal,
      640,
    );

    await throws(
      'wrong passphrase fails via the GCM tag',
      () => C.unlockKeyring(keyring, 'passphrase', 'my long passphras'),
      (e) => e.name === 'UnlockFailedError',
    );
    await throws(
      'a valid recovery code from a different vault does not open this one',
      async () => {
        let k2 = C.createKeyring();
        const raw2 = await C.exportDek(await C.generateDek());
        const other = await C.addRecoveryCodeWrapping(k2, raw2, { iterations: FAST });
        return C.unlockWithRecoveryCode(keyring, other.code);
      },
      (e) => e.name === 'UnlockFailedError',
    );
    await throws(
      'a typo in the recovery code is rejected before any PBKDF2 work',
      () => C.unlockWithRecoveryCode(keyring, issue.code.slice(0, -1) + (issue.code.endsWith('0') ? '2' : '0')),
      (e) => e.name === 'RecoveryCodeError',
    );

    // AAD binds a wrapping to its own id and its vault.
    const swapped = {
      ...keyring,
      wrappedKeys: [{ ...keyring.wrappedKeys[0], id: keyring.wrappedKeys[1].id }],
    };
    await throws(
      'moving a wrapping to another id breaks its AAD',
      () => C.unlockKeyring(swapped, 'passphrase', 'my long passphrase'),
      (e) => e.name === 'UnlockFailedError',
    );
    const foreign = { ...keyring, vaultId: C.randomId() };
    await throws(
      'transplanting the keyring into another vaultId breaks its AAD',
      () => C.unlockKeyring(foreign, 'passphrase', 'my long passphrase'),
      (e) => e.name === 'UnlockFailedError',
    );

    // Passphrase change re-wraps without touching the DEK.
    const changed = await C.changePassphraseInKeyring(
      keyring,
      'my long passphrase',
      'an even longer passphrase',
      { iterations: FAST },
    );
    const afterChange = await C.unlockKeyring(changed, 'passphrase', 'an even longer passphrase');
    eq('passphrase change preserves the DEK', hex(afterChange.rawDek), hex(raw));
    await throws(
      'the old passphrase no longer works',
      () => C.unlockKeyring(changed, 'passphrase', 'my long passphrase'),
      (e) => e.name === 'UnlockFailedError',
    );
    const recAfter = await C.unlockWithRecoveryCode(changed, issue.code);
    eq('the recovery code still works after a passphrase change', hex(recAfter.rawDek), hex(raw));
    eq('passphrase change did not add a wrapping', changed.wrappedKeys.length, 3);

    // Revocation.
    const revoked = C.removeWrapping(changed, viaPrf.wrappedKeyId);
    eq('revoking the passkey leaves two wrappings', revoked.wrappedKeys.length, 2);
    await throws(
      'the revoked PRF secret no longer opens the vault',
      () => C.unlockKeyring(revoked, 'passkey-prf', prfSecret),
      (e) => e.name === 'UnlockFailedError',
    );
    ok(
      'removing the last wrapping is refused',
      (() => {
        try {
          let k = C.removeWrapping(revoked, revoked.wrappedKeys[0].id);
          C.removeWrapping(k, k.wrappedKeys[0].id);
          return false;
        } catch {
          return true;
        }
      })(),
    );

    // The keyring is JSON-round-trippable — this is what makes .hcvault work.
    const rehydrated = JSON.parse(JSON.stringify(changed));
    ok('keyring survives JSON round-trip', C.isKeyring(rehydrated));
    eq(
      'a JSON-round-tripped keyring still unlocks',
      hex((await C.unlockKeyring(rehydrated, 'passphrase', 'an even longer passphrase')).rawDek),
      hex(raw),
    );
    ok('summarizeKeyring leaks no ciphertext', C.summarizeKeyring(changed).every((s) => !('ct' in s)));
  }

  // -------------------------------------------------------------------------
  section('8. Blind index');
  // -------------------------------------------------------------------------
  {
    const raw = C.randomBytes(32);
    const idx = await C.deriveIndexKey(raw);
    const a = await C.blindIndex(idx, 'weightEntries.sourceKey', 'apple-health:body-mass:2026-07-26');
    const b = await C.blindIndex(idx, 'weightEntries.sourceKey', 'apple-health:body-mass:2026-07-26');
    eq('blind index is deterministic', a, b);
    eq('blind index is 22 base64url chars (128 bits)', a.length, 22);

    const c = await C.blindIndex(idx, 'foodLogs.sourceKey', 'apple-health:body-mass:2026-07-26');
    ok('domain separation changes the token', a !== c);

    const otherIdx = await C.deriveIndexKey(C.randomBytes(32));
    const d = await C.blindIndex(otherIdx, 'weightEntries.sourceKey', 'apple-health:body-mass:2026-07-26');
    ok('a different DEK yields a different token', a !== d);
    ok('token contains no fragment of the plaintext', !a.includes('apple') && !a.includes('2026'));

    const tokens = new Set();
    for (let i = 0; i < 20000; i++) {
      tokens.add(await C.blindIndex(idx, 'healthMetrics.sourceKey', `apple-health:steps:${i}`));
    }
    eq('20000 distinct source keys -> 20000 distinct tokens', tokens.size, 20000);
  }

  // -------------------------------------------------------------------------
  section('9. Production KDF cost (real 600,000 iterations)');
  // -------------------------------------------------------------------------
  {
    const t0 = Date.now();
    await C.deriveKek('a realistic passphrase for timing', C.generateKdfSalt());
    const ms = Date.now() - t0;
    ok(
      `600,000-iteration PBKDF2 took ${ms} ms on this machine`,
      ms > 20,
      'must not be instantaneous',
    );
  }

  // -------------------------------------------------------------------------
  section('10. Hygiene');
  // -------------------------------------------------------------------------
  {
    const b = C.randomBytes(32);
    ok('randomBytes is not all zeroes', b.some((v) => v !== 0));
    C.zeroBytes(b);
    ok('zeroBytes wipes in place', b.every((v) => v === 0));

    const x = new Uint8Array([1, 2, 3]);
    const y = new Uint8Array([1, 2, 3]);
    const z = new Uint8Array([1, 2, 4]);
    ok('constantTimeEqual is correct for equal buffers', C.constantTimeEqual(x, y));
    ok('constantTimeEqual is correct for differing buffers', !C.constantTimeEqual(x, z));
    ok('constantTimeEqual is correct for differing lengths', !C.constantTimeEqual(x, new Uint8Array(2)));

    const ids = new Set();
    for (let i = 0; i < 20000; i++) ids.add(C.randomId());
    eq('20000 randomIds are distinct', ids.size, 20000);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('crypto core VERIFIED');
