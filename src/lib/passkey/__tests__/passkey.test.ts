import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toBase64Url } from '@/lib/crypto';

const vault = vi.hoisted(() => ({
  loadKeyring: vi.fn(),
  registerSecretWrapping: vi.fn(),
  removeWrapping: vi.fn(),
  unlockWithSecret: vi.fn(),
}));

vi.mock('@/lib/vault', () => vault);

import {
  PasskeyPrfError,
  enrollPasskey,
  listPasskeys,
  passkeyCapability,
  revokePasskey,
  unlockWithPasskey,
} from '../passkey';

const CREDENTIAL_ID = new Uint8Array([1, 2, 3, 4]);
const CREDENTIAL_ID_TEXT = toBase64Url(CREDENTIAL_ID);
const SALT = new Uint8Array(32).fill(7);
const SECRET = new Uint8Array(32).fill(9);

class FakePublicKeyCredential {
  static isUserVerifyingPlatformAuthenticatorAvailable = vi.fn(async () => true);
}

function credential(
  output: { enabled?: boolean; first?: Uint8Array },
  rawId: Uint8Array = CREDENTIAL_ID,
) {
  return {
    type: 'public-key',
    rawId: rawId.buffer.slice(rawId.byteOffset, rawId.byteOffset + rawId.byteLength),
    getClientExtensionResults: () => ({
      prf: {
        ...(output.enabled === undefined ? {} : { enabled: output.enabled }),
        ...(output.first
          ? {
              results: {
                first: output.first.buffer.slice(
                  output.first.byteOffset,
                  output.first.byteOffset + output.first.byteLength,
                ),
              },
            }
          : {}),
      },
    }),
  };
}

function keyringWithPasskey() {
  return {
    version: 1,
    vaultId: 'vault-id',
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    wrappedKeys: [
      {
        id: 'wrap-id',
        method: 'passkey-prf',
        label: 'This iPhone — Face ID',
        createdAt: '2026-08-01T12:00:00.000Z',
        lastUsedAt: null,
        meta: {
          credentialId: CREDENTIAL_ID_TEXT,
          prfSalt: toBase64Url(SALT),
          rpId: 'keel.example',
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const fakeWindow = {
    isSecureContext: true,
    location: { hostname: 'keel.example' },
  } as unknown as Window & typeof globalThis;
  Object.defineProperties(fakeWindow, {
    self: { value: fakeWindow },
    top: { value: fakeWindow },
  });
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential);
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone)',
    credentials: { create: vi.fn(), get: vi.fn() },
  });
  FakePublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable.mockResolvedValue(true);
  vault.loadKeyring.mockResolvedValue({
    version: 1,
    vaultId: 'vault-id',
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    wrappedKeys: [],
  });
  vault.registerSecretWrapping.mockResolvedValue('new-wrap-id');
  vault.removeWrapping.mockResolvedValue(undefined);
  vault.unlockWithSecret.mockResolvedValue(undefined);
});

describe('WebAuthn PRF passkeys', () => {
  it('detects a secure top-level platform authenticator', async () => {
    await expect(passkeyCapability()).resolves.toEqual({
      secureContext: true,
      topLevel: true,
      webAuthn: true,
      platformAuthenticator: true,
      potentiallyAvailable: true,
    });
  });

  it('degrades without prompting when no platform authenticator is available', async () => {
    FakePublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable.mockResolvedValue(false);

    expect((await passkeyCapability()).potentiallyAvailable).toBe(false);
    await expect(enrollPasskey()).rejects.toThrow(/does not offer/i);
    expect(navigator.credentials.create).not.toHaveBeenCalled();
  });

  it('enrols a user-verified platform credential and stores only public metadata', async () => {
    vi.mocked(navigator.credentials.create).mockResolvedValue(
      credential({ enabled: true, first: SECRET }) as unknown as Credential,
    );
    let capturedSecret: number[] = [];
    vault.registerSecretWrapping.mockImplementation(async (secret: Uint8Array) => {
      capturedSecret = [...secret];
      return 'new-wrap-id';
    });

    const enrolled = await enrollPasskey();

    expect(capturedSecret).toEqual([...SECRET]);
    expect(enrolled.credentialId).toBe(CREDENTIAL_ID_TEXT);
    const createOptions = vi.mocked(navigator.credentials.create).mock.calls[0][0]
      ?.publicKey as PublicKeyCredentialCreationOptions;
    expect(createOptions.authenticatorSelection).toMatchObject({
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(createOptions.attestation).toBe('none');
    expect(createOptions.challenge).toHaveLength(32);
    expect(createOptions.user.id).toHaveLength(32);
    expect(vault.registerSecretWrapping).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        credentialId: CREDENTIAL_ID_TEXT,
        meta: expect.objectContaining({ rpId: 'keel.example' }),
      }),
    );
  });

  it('uses an immediate assertion when creation enables PRF but returns no value', async () => {
    vi.mocked(navigator.credentials.create).mockResolvedValue(
      credential({ enabled: true }) as unknown as Credential,
    );
    vi.mocked(navigator.credentials.get).mockResolvedValue(
      credential({ first: SECRET }) as unknown as Credential,
    );

    await enrollPasskey();

    expect(navigator.credentials.get).toHaveBeenCalledOnce();
    expect(vault.registerSecretWrapping).toHaveBeenCalledOnce();
  });

  it('does not add a wrapping when the created credential lacks PRF support', async () => {
    vi.mocked(navigator.credentials.create).mockResolvedValue(
      credential({ enabled: false }) as unknown as Credential,
    );

    await expect(enrollPasskey()).rejects.toBeInstanceOf(PasskeyPrfError);
    expect(vault.registerSecretWrapping).not.toHaveBeenCalled();
  });

  it('evaluates the stored salt for the returned credential and unlocks the matching wrapping', async () => {
    vault.loadKeyring.mockResolvedValue(keyringWithPasskey());
    vi.mocked(navigator.credentials.get).mockResolvedValue(
      credential({ first: SECRET }) as unknown as Credential,
    );
    let capturedSecret: number[] = [];
    vault.unlockWithSecret.mockImplementation(async (secret: Uint8Array) => {
      capturedSecret = [...secret];
    });

    await unlockWithPasskey();

    expect(capturedSecret).toEqual([...SECRET]);
    expect(vault.unlockWithSecret).toHaveBeenCalledWith(expect.any(Uint8Array), {
      credentialId: CREDENTIAL_ID_TEXT,
    });
    const request = vi.mocked(navigator.credentials.get).mock.calls[0][0]
      ?.publicKey as PublicKeyCredentialRequestOptions & {
      extensions: { prf: { evalByCredential: Record<string, { first: Uint8Array }> } };
    };
    expect(request.userVerification).toBe('required');
    expect(request.allowCredentials).toHaveLength(1);
    expect(Array.from(request.extensions.prf.evalByCredential[CREDENTIAL_ID_TEXT].first)).toEqual([
      ...SALT,
    ]);
  });

  it('ignores malformed passkey metadata and revokes by wrapping id', async () => {
    const keyring = keyringWithPasskey();
    vault.loadKeyring.mockResolvedValue({
      ...keyring,
      wrappedKeys: [
        ...keyring.wrappedKeys,
        { ...keyring.wrappedKeys[0], id: 'bad', meta: { credentialId: '!', prfSalt: 'x' } },
      ],
    });

    await expect(listPasskeys()).resolves.toHaveLength(1);
    await revokePasskey('wrap-id');
    expect(vault.removeWrapping).toHaveBeenCalledWith('wrap-id');
  });

  it('refuses a passkey wrapping known to belong to another origin', async () => {
    const keyring = keyringWithPasskey();
    vault.loadKeyring.mockResolvedValue({
      ...keyring,
      wrappedKeys: keyring.wrappedKeys.map((wrapping) => ({
        ...wrapping,
        meta: { ...wrapping.meta, rpId: 'old-keel.example' },
      })),
    });

    await expect(unlockWithPasskey()).rejects.toThrow(/different Keel address/i);
    expect(navigator.credentials.get).not.toHaveBeenCalled();
    expect(vault.unlockWithSecret).not.toHaveBeenCalled();
  });
});
