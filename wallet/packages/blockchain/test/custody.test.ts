import { describe, expect, it } from 'vitest';
import {
  checkTierAuthorization,
  CUSTODY_TIERS,
  parseAuthorities,
  planRebalance,
  tierForWithdrawal,
  TIER_POLICIES,
} from '../src/custody.js';

// ---------------------------------------------------------------------------
// Rule 137: tiers that all sign the same way are labels, not segregation
// ---------------------------------------------------------------------------

describe('custody tiers are genuinely different (rules 136-137)', () => {
  it('gives NO TWO TIERS the same signing policy', () => {
    // The executable form of rule 137. If this ever passes trivially because
    // every tier was given the same policy, the tiers have become labels.
    const signatures = CUSTODY_TIERS.map((tier) => {
      const p = TIER_POLICIES[tier];
      return [
        [...p.requiredAuthorities].sort().join('+'),
        p.signingThreshold,
        p.fixedDestinationOnly,
        p.online,
      ].join('|');
    });

    expect(new Set(signatures).size).toBe(CUSTODY_TIERS.length);
  });

  it('requires strictly more as the tier gets colder', () => {
    expect(TIER_POLICIES.hot.requiredAuthorities).toEqual(['risk-engine']);
    expect(TIER_POLICIES.warm.requiredAuthorities).toContain('operator');
    expect(TIER_POLICIES.cold.requiredAuthorities).toContain('ceremony');
    expect(TIER_POLICIES.cold.signingThreshold).toBeGreaterThan(TIER_POLICIES.hot.signingThreshold);
  });

  it('keeps the deposit class unable to choose a destination (ADR-0005)', () => {
    // The commitment that justified holding deposit keys under weaker
    // protection. If this is ever false, ADR-0005 was a story we told
    // ourselves.
    expect(TIER_POLICIES.deposit.fixedDestinationOnly).toBe(true);
    for (const tier of ['hot', 'warm', 'cold'] as const) {
      expect(TIER_POLICIES[tier].fixedDestinationOnly).toBe(false);
    }
  });

  it('keeps cold offline', () => {
    expect(TIER_POLICIES.cold.online).toBe(false);
  });
});

describe('authorization checking', () => {
  it('accepts a hot movement approved by the risk engine alone', () => {
    expect(checkTierAuthorization('hot', 'risk-engine')).toEqual({ ok: true });
  });

  it('REFUSES a warm movement carrying only the risk engine', () => {
    // The whole point: a compromised API can produce a risk-engine proof. It
    // cannot produce an operator's signature.
    expect(checkTierAuthorization('warm', 'risk-engine')).toMatchObject({
      ok: false,
      missing: ['operator'],
    });
  });

  it('accepts a warm movement with both authorities', () => {
    expect(checkTierAuthorization('warm', 'risk-engine+operator:alice')).toEqual({ ok: true });
  });

  it('REFUSES a cold movement approved by automation', () => {
    expect(checkTierAuthorization('cold', 'risk-engine+operator:alice').ok).toBe(false);
  });

  it('accepts a cold movement carrying a ceremony', () => {
    expect(checkTierAuthorization('cold', 'ceremony:2026-09-11')).toEqual({ ok: true });
  });

  it('DROPS an unrecognised authority rather than accepting it', () => {
    // Failing open here would make the entire policy decorative: a proof
    // claiming `superuser` must satisfy nothing at all.
    expect(parseAuthorities('superuser+root')).toEqual([]);
    expect(checkTierAuthorization('warm', 'superuser').ok).toBe(false);
  });

  it('is not fooled by an authority name appearing as an identity', () => {
    // `operator:operator` names one authority, not two.
    expect(parseAuthorities('operator:operator')).toEqual(['operator']);
    // `operator:risk-engine` names ONE authority, so warm — which needs two
    // distinct approvals — is still refused.
    expect(checkTierAuthorization('warm', 'operator:risk-engine').ok).toBe(false);
  });

  it('requires nothing of a deposit key, which cannot choose where to send', () => {
    expect(checkTierAuthorization('deposit', '')).toEqual({ ok: true });
  });
});

describe('tier selection and rebalancing (rule 135)', () => {
  it('serves an ordinary withdrawal from hot', () => {
    expect(tierForWithdrawal({ amount: 10n, hotBalance: 100n })).toBe('hot');
  });

  it('reports insufficient hot rather than silently reaching into warm', () => {
    // Reaching into warm automatically would make the colder tier's
    // protections apply to routine traffic, which is the thing tiers exist to
    // avoid.
    expect(tierForWithdrawal({ amount: 500n, hotBalance: 100n })).toBe('insufficient_hot');
  });

  it('moves the excess to warm automatically when hot exceeds its ceiling', () => {
    expect(planRebalance({ hotBalance: 1000n, ceiling: 800n, floor: 200n, target: 500n })).toEqual({
      action: 'to_warm',
      amount: 500n,
    });
  });

  it('REQUESTS a top-up rather than performing one when hot is low', () => {
    // Asymmetry by design: into cold is automatic, out of cold is privileged.
    expect(planRebalance({ hotBalance: 100n, ceiling: 800n, floor: 200n, target: 500n })).toEqual({
      action: 'from_warm',
      amount: 400n,
    });
  });

  it('does nothing between the floor and the ceiling', () => {
    expect(
      planRebalance({ hotBalance: 500n, ceiling: 800n, floor: 200n, target: 500n }).action,
    ).toBe('none');
  });

  it('refuses a ceiling below the floor', () => {
    expect(() =>
      planRebalance({ hotBalance: 1n, ceiling: 100n, floor: 200n, target: 150n }),
    ).toThrow(/ceiling/);
  });
});

// ---------------------------------------------------------------------------
// The authority hierarchy (ADR-0018)
// ---------------------------------------------------------------------------

describe('an operator carries more authority than automation, not less', () => {
  it('lets an operator satisfy a hot-tier requirement alone', () => {
    // Surfaced by the nonce-provisioning script: an operator acting directly
    // on hot was refused for carrying too MUCH authority, and the obvious
    // workaround would have been a proof falsely claiming `risk-engine`.
    expect(checkTierAuthorization('hot', 'operator:alice')).toEqual({ ok: true });
  });

  it('lets a ceremony satisfy a hot-tier requirement', () => {
    expect(checkTierAuthorization('hot', 'ceremony:2026-09-11')).toEqual({ ok: true });
  });

  it('still REFUSES automation where a human is required', () => {
    // The direction that matters. This is the substitution a compromised
    // coordinator would like to make, and it must never succeed.
    expect(checkTierAuthorization('warm', 'risk-engine').ok).toBe(false);
    expect(checkTierAuthorization('cold', 'risk-engine').ok).toBe(false);
  });

  it('does not let a ceremony stand in for a named operator', () => {
    // Different procedures: a ceremony proof names no individual, so warm's
    // accountability requirement is not met by one.
    expect(checkTierAuthorization('warm', 'ceremony:2026-09-11')).toMatchObject({ ok: false });
  });

  it('accepts warm when both are present', () => {
    expect(checkTierAuthorization('warm', 'risk-engine+operator:alice')).toEqual({ ok: true });
  });
});

describe('warm means TWO approvals, not one senior one', () => {
  it('refuses a lone operator on warm', () => {
    // The subtle one. With a naive hierarchy check, `operator` satisfies the
    // operator requirement AND the risk-engine requirement, silently reducing
    // warm from two independent approvals to one — which is the whole
    // protection warm exists to give.
    expect(checkTierAuthorization('warm', 'operator:alice')).toMatchObject({ ok: false });
  });

  it('accepts two distinct authorities on warm', () => {
    expect(checkTierAuthorization('warm', 'risk-engine+operator:alice')).toEqual({ ok: true });
    // A ceremony can stand in for the risk engine, leaving the operator to
    // meet its own requirement.
    expect(checkTierAuthorization('warm', 'ceremony:2026-09-11+operator:alice')).toEqual({
      ok: true,
    });
  });

  it('still accepts a single operator on hot, which needs only one', () => {
    expect(checkTierAuthorization('hot', 'operator:alice')).toEqual({ ok: true });
  });
});
