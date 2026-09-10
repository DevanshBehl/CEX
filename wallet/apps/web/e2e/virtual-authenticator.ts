import type { Page } from '@playwright/test';

/**
 * A software WebAuthn authenticator, via Chrome DevTools Protocol.
 *
 * Without this, an E2E suite either skips the passkey ceremony entirely — which
 * is most of what Phase 1 built — or needs a human to touch a security key.
 * The virtual authenticator makes the real ceremony run: real challenge, real
 * signature, real verification server-side.
 *
 * `hasResidentKey` and `isUserVerified` are what make discoverable credentials
 * work, so login needs no identifier (rule 119).
 */
export interface VirtualAuthenticator {
  readonly authenticatorId: string;
  /** Simulates the credential being used on a second device. */
  setUserVerified(verified: boolean): Promise<void>;
  credentialCount(): Promise<number>;
  remove(): Promise<void>;
}

export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable', { enableUI: false });

  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  return {
    authenticatorId,
    async setUserVerified(verified) {
      await client.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: verified });
    },
    async credentialCount() {
      const result = await client.send('WebAuthn.getCredentials', { authenticatorId });
      return result.credentials.length;
    },
    async remove() {
      await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    },
  };
}
