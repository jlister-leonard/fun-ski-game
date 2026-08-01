/**
 * @file Browser WebAuthn PRF ceremonies for local Face ID / passkey unlock.
 *
 * There is no authentication server in Keel. WebAuthn supplies a
 * user-verified, credential-bound 32-byte PRF output; the vault layer uses
 * that output to wrap or unwrap its existing DEK. Challenges are still fresh
 * and random so every ceremony requires a new authenticator operation.
 */

import { fromBase64Url, randomBytes, toBase64Url } from '@/lib/crypto';
import {
  loadKeyring,
  registerSecretWrapping,
  removeWrapping,
  unlockWithSecret,
} from '@/lib/vault';

const PRF_BYTES = 32;
const CHALLENGE_BYTES = 32;
const USER_HANDLE_BYTES = 32;
const CEREMONY_TIMEOUT_MS = 60_000;

type PrfValues = { first?: BufferSource };
type PrfResults = { enabled?: boolean; results?: PrfValues };

interface PrfCredential extends PublicKeyCredential {
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs & {
    prf?: PrfResults;
  };
}

/** Public data needed to invoke or revoke one passkey wrapping. */
export interface PasskeyDescriptor {
  readonly wrappingId: string;
  readonly credentialId: string;
  readonly prfSalt: string;
  readonly rpId: string | null;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** What can be known without creating a credential. */
export interface PasskeyCapability {
  readonly secureContext: boolean;
  readonly topLevel: boolean;
  readonly webAuthn: boolean;
  readonly platformAuthenticator: boolean;
  /** PRF itself can only be proved by a real create/get result. */
  readonly potentiallyAvailable: boolean;
}

export class PasskeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyUnavailableError';
  }
}

export class PasskeyPrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyPrfError';
  }
}

/** Detect the prerequisites browsers expose without prompting the user. */
export async function passkeyCapability(): Promise<PasskeyCapability> {
  const secureContext = typeof window !== 'undefined' && window.isSecureContext;
  const topLevel = isTopLevelContext();
  const webAuthn =
    typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function';

  let platformAuthenticator = false;
  if (
    webAuthn &&
    typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
  ) {
    try {
      platformAuthenticator =
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      platformAuthenticator = false;
    }
  }

  return {
    secureContext,
    topLevel,
    webAuthn,
    platformAuthenticator,
    potentiallyAvailable:
      secureContext && topLevel && webAuthn && platformAuthenticator,
  };
}

/** Read valid passkey metadata from the public keyring. */
export async function listPasskeys(): Promise<PasskeyDescriptor[]> {
  const keyring = await loadKeyring();
  if (!keyring) return [];
  const out: PasskeyDescriptor[] = [];
  for (const wrapping of keyring.wrappedKeys) {
    if (wrapping.method !== 'passkey-prf') continue;
    const credentialId = wrapping.meta?.credentialId;
    const prfSalt = wrapping.meta?.prfSalt;
    if (!credentialId || !prfSalt) continue;
    try {
      if (fromBase64Url(credentialId).byteLength === 0) continue;
      if (fromBase64Url(prfSalt).byteLength !== PRF_BYTES) continue;
    } catch {
      continue;
    }
    out.push({
      wrappingId: wrapping.id,
      credentialId,
      prfSalt,
      rpId: wrapping.meta?.rpId ?? null,
      label: wrapping.label,
      createdAt: wrapping.createdAt,
      lastUsedAt: wrapping.lastUsedAt,
    });
  }
  return out;
}

/** Create a platform passkey, obtain its PRF output, and wrap the vault DEK. */
export async function enrollPasskey(label = defaultPasskeyLabel()): Promise<PasskeyDescriptor> {
  await requireCapability();
  const keyring = await loadKeyring();
  if (!keyring) throw new PasskeyUnavailableError('Set up the vault before adding Face ID.');

  const salt = randomBytes(PRF_BYTES);
  const existing = await listPasskeys();
  const publicKey = {
    challenge: randomBytes(CHALLENGE_BYTES),
    rp: { name: 'Keel' },
    user: {
      id: randomBytes(USER_HANDLE_BYTES),
      name: 'Local Keel vault',
      displayName: 'Local Keel vault',
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: CEREMONY_TIMEOUT_MS,
    attestation: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    excludeCredentials: existing.map((item) => ({
      type: 'public-key',
      id: fromBase64Url(item.credentialId),
    })),
    extensions: { prf: { eval: { first: salt } } },
  } as unknown as PublicKeyCredentialCreationOptions;

  const created = (await navigator.credentials.create({ publicKey })) as PrfCredential | null;
  if (!created || created.type !== 'public-key') {
    throw new PasskeyUnavailableError('The passkey was not created. Nothing changed.');
  }

  const credentialId = toBase64Url(new Uint8Array(created.rawId));
  let secret = readPrfOutput(created);
  const creationPrf = created.getClientExtensionResults().prf;
  if (creationPrf?.enabled !== true) {
    throw new PasskeyPrfError(
      'This passkey does not provide the encryption feature Keel needs. Your passphrase is unchanged.',
    );
  }

  // The standard permits creation to report PRF support without evaluating
  // it. In that case, immediately run an assertion for the new credential.
  if (!secret) secret = await evaluatePrf([{ credentialId, prfSalt: toBase64Url(salt) }]);
  try {
    const wrappingId = await registerSecretWrapping(secret, {
      label,
      credentialId,
      meta: {
        prfSalt: toBase64Url(salt),
        rpId: window.location.hostname,
      },
    });
    return {
      wrappingId,
      credentialId,
      prfSalt: toBase64Url(salt),
      rpId: window.location.hostname,
      label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
  } finally {
    secret.fill(0);
  }
}

/** Ask the platform authenticator for a PRF output and unlock the vault. */
export async function unlockWithPasskey(): Promise<void> {
  await requireCapability();
  const passkeys = await listPasskeys();
  if (passkeys.length === 0) {
    throw new PasskeyUnavailableError('No Face ID passkey is enrolled for this vault.');
  }
  const here = window.location.hostname;
  const usable = passkeys.filter((passkey) => !passkey.rpId || passkey.rpId === here);
  if (usable.length === 0) {
    throw new PasskeyUnavailableError(
      'This passkey belongs to a different Keel address. Use your passphrase, then add this device again.',
    );
  }
  const { credentialId, secret } = await evaluatePrfWithCredential(usable);
  try {
    await unlockWithSecret(secret, { credentialId });
  } finally {
    secret.fill(0);
  }
}

/** Revoke the vault wrapping. The OS may retain an inert saved passkey. */
export async function revokePasskey(wrappingId: string): Promise<void> {
  await removeWrapping(wrappingId);
}

async function requireCapability(): Promise<void> {
  const capability = await passkeyCapability();
  if (!capability.secureContext) {
    throw new PasskeyUnavailableError('Face ID unlock requires Keel over a secure HTTPS connection.');
  }
  if (!capability.topLevel) {
    throw new PasskeyUnavailableError('Open Keel directly or from its Home Screen icon to use Face ID.');
  }
  if (!capability.webAuthn || !capability.platformAuthenticator) {
    throw new PasskeyUnavailableError('This browser or device does not offer a usable Face ID passkey.');
  }
}

async function evaluatePrf(
  passkeys: readonly Pick<PasskeyDescriptor, 'credentialId' | 'prfSalt'>[],
): Promise<Uint8Array> {
  return (await evaluatePrfWithCredential(passkeys)).secret;
}

async function evaluatePrfWithCredential(
  passkeys: readonly Pick<PasskeyDescriptor, 'credentialId' | 'prfSalt'>[],
): Promise<{ credentialId: string; secret: Uint8Array }> {
  const evalByCredential: Record<string, { first: Uint8Array }> = {};
  const allowCredentials = passkeys.map((item) => {
    evalByCredential[item.credentialId] = { first: fromBase64Url(item.prfSalt) };
    return { type: 'public-key' as const, id: fromBase64Url(item.credentialId) };
  });
  const publicKey = {
    challenge: randomBytes(CHALLENGE_BYTES),
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: 'required',
    allowCredentials,
    extensions: { prf: { evalByCredential } },
  } as unknown as PublicKeyCredentialRequestOptions;
  const assertion = (await navigator.credentials.get({ publicKey })) as PrfCredential | null;
  if (!assertion || assertion.type !== 'public-key') {
    throw new PasskeyUnavailableError('The passkey request was cancelled.');
  }
  const credentialId = toBase64Url(new Uint8Array(assertion.rawId));
  if (!passkeys.some((item) => item.credentialId === credentialId)) {
    throw new PasskeyPrfError('The authenticator returned an unexpected passkey.');
  }
  const secret = readPrfOutput(assertion);
  if (!secret) {
    throw new PasskeyPrfError(
      'This passkey did not return the encryption secret Keel needs. Use your passphrase instead.',
    );
  }
  return { credentialId, secret };
}

function readPrfOutput(credential: PrfCredential): Uint8Array | null {
  const first = credential.getClientExtensionResults().prf?.results?.first;
  if (!first) return null;
  if (first instanceof ArrayBuffer) {
    return first.byteLength === PRF_BYTES ? new Uint8Array(first.slice(0)) : null;
  }
  if (!ArrayBuffer.isView(first) || first.byteLength !== PRF_BYTES) return null;
  return new Uint8Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength));
}

function isTopLevelContext(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

function defaultPasskeyLabel(): string {
  if (typeof navigator === 'undefined') return 'This device — passkey';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'This iPhone or iPad — Face ID';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'This Mac — Touch ID';
  return 'This device — passkey';
}
