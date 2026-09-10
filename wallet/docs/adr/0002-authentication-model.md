# ADR-0002: Passkey-first authentication, with TOTP as a second factor

- **Status:** accepted
- **Date:** 2026-09-10
- **Phase:** 1

## Context

master-prompt rule 37 asks for passkeys/WebAuthn plus optional email and 2FA.
Rule 4 forbids ever handing the user a seed phrase — the product promise is that
custody is the platform's problem, so the sign-in story has to be at least as
easy as a password without being a password.

## Decision

WebAuthn is the primary and default authentication method. An account can exist
with no email and no password at all. TOTP is available as a second factor, and
recovery codes are issued when it is enabled. Login uses discoverable
credentials, so the user types nothing.

Step-up re-authentication (`requireStepUp`) is a first-class primitive from day
one, gating credential management and 2FA changes in Phase 1 and withdrawal
submission in Phase 3.

## Alternatives considered

**Password-first with passkeys as an upgrade.** The familiar path, and it makes
account recovery easy. Rejected because it makes the weakest factor the one
every account has: phishing and credential stuffing are the two attacks that
actually take custodial accounts, and both target passwords.

**Passkeys only, no TOTP at all.** Simpler, and TOTP is the weaker factor.
Rejected because a synced-passkey provider account compromise would otherwise be
a single point of failure with no second gate.

## Known limitation: registration is enumerable

Login is fully non-enumerable — `/auth/login/options` takes no identifier that
could change its answer, so there is no oracle (rules 141, 179, tested).

Registration is not. Submitting an email that already has an account returns a
`CONFLICT`, which confirms the address is registered. The standard fix is to
accept the registration silently and send an email saying "you already have an
account" — which needs a mail transport, and prompt_phase1.md rule 24 puts email
delivery out of Phase 1 scope.

Mitigations in place: the endpoint is rate-limited per IP, email is optional at
registration, and a passkey-only account leaks nothing. **This is a deliberate,
recorded gap, not an oversight.** It should be closed when email delivery
arrives.

## Consequences

- A user with one passkey on one device is one lost device away from lockout.
  The UI pushes for a second passkey; recovery codes cover the 2FA factor but
  not the passkey itself. A full account-recovery flow is unbuilt and is a
  prerequisite before this system ever holds anything valuable.
- WebAuthn `rpId` and `origin` come from validated config and never from a
  request header. Getting this wrong is the most common WebAuthn failure, so
  `packages/config` rejects an `rpId` that is not a registrable suffix of the
  configured origin, at boot.
- Signature-counter clone detection is implemented, with the important
  exception that a stored counter of 0 is never treated as suspicious — synced
  passkey providers report 0 forever, and flagging them would lock out most
  real users.
