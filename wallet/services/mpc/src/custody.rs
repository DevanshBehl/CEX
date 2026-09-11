//! Custody tiers, enforced where a compromised coordinator cannot skip them.
//!
//! ADR-0018, prompt_phase4.md rules 134-139.
//!
//! # Why this lives in the signing service
//!
//! The TypeScript side has the same policy table (`packages/blockchain/
//! src/custody.ts`) and the domain reasons about tiers with it. That copy is
//! advisory. **This one decides.**
//!
//! ADR-0015 establishes that the API is the coordinator and that a compromised
//! coordinator must be a liveness problem rather than a safety one. A tier
//! check that lived only in the API would be a check the compromised component
//! performs on itself. So the authority requirements are re-derived here, from
//! the tier named in the request, against a proof signed by a key this service
//! holds independently of the caller.
//!
//! Rule 137 is the thing being defended: tiers that all sign the same way are
//! labels, not segregation.

use serde::{Deserialize, Serialize};

/// Ordered from most to least exposed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CustodyTier {
    Deposit,
    Hot,
    Warm,
    Cold,
}

/// Who must have signed an authorisation for a tier to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    RiskEngine,
    Operator,
    Ceremony,
}

impl Authority {
    fn parse(name: &str) -> Option<Self> {
        match name.trim() {
            "risk-engine" => Some(Self::RiskEngine),
            "operator" => Some(Self::Operator),
            "ceremony" => Some(Self::Ceremony),
            // Anything else satisfies NOTHING. Failing open here would make
            // the policy decorative: a proof claiming `superuser` must not
            // count as an operator.
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RiskEngine => "risk-engine",
            Self::Operator => "operator",
            Self::Ceremony => "ceremony",
        }
    }
}

impl CustodyTier {
    /// Every authority that must appear in the proof for this tier.
    ///
    /// The asymmetry is deliberate: moving value INTO colder storage is
    /// automatic, moving it OUT is privileged. Getting the conservative
    /// direction wrong costs a transfer; getting the other one wrong costs the
    /// treasury.
    pub fn required_authorities(self) -> &'static [Authority] {
        match self {
            // A deposit key cannot choose a destination (ADR-0005), so there
            // is nothing for an authorisation to authorise beyond "sweep now".
            Self::Deposit => &[],
            Self::Hot => &[Authority::RiskEngine],
            Self::Warm => &[Authority::RiskEngine, Authority::Operator],
            // Two humans, out of band. No automated authority satisfies this.
            Self::Cold => &[Authority::Ceremony],
        }
    }

    /// Signing participants required. Secondary to the authority check: raising
    /// the threshold defends against participant compromise, while the
    /// authority requirement defends against a compromised coordinator.
    pub fn signing_threshold(self) -> u8 {
        match self {
            Self::Deposit => 1,
            Self::Hot | Self::Warm => 3,
            Self::Cold => 4,
        }
    }

    /// True when this key class may only ever pay one hardcoded destination.
    pub fn fixed_destination_only(self) -> bool {
        matches!(self, Self::Deposit)
    }
}

/// Parse the authorities an `approved_by` field claims.
///
/// Format is `authority[:identity]`, joined by `+`:
///
/// ```text
/// risk-engine
/// risk-engine+operator:alice
/// ceremony:2026-09-11
/// ```
pub fn parse_authorities(approved_by: &str) -> Vec<Authority> {
    approved_by
        .split('+')
        .filter_map(|part| Authority::parse(part.split(':').next().unwrap_or("")))
        .collect()
}

/// Does this proof carry everything the tier requires?
///
/// Returns the first missing authority, for an error message an operator can
/// act on. Deliberately NOT a risk evaluation: this checks the attestation,
/// not the policy (master-prompt rule 109).
/// Does `held` satisfy a requirement for `required`?
///
/// # The asymmetry that matters
///
/// A human operator satisfies a requirement for the risk engine: a named person
/// deliberately approving a movement is strictly more authority than automation
/// applying a policy, and a ceremony is more than either. The reverse is never
/// true — automation must never satisfy a requirement for a human, because that
/// is exactly the substitution a compromised coordinator would like to make.
fn satisfies(held: Authority, required: Authority) -> bool {
    if held == required {
        return true;
    }
    match required {
        Authority::RiskEngine => matches!(held, Authority::Operator | Authority::Ceremony),
        // An operator requirement is NOT satisfied by a ceremony: they are
        // different procedures, and a ceremony proof names no individual.
        _ => false,
    }
}

/// How many authorities could satisfy this requirement. Used to match the
/// most-constrained requirement first.
fn satisfier_count(required: Authority) -> usize {
    [
        Authority::RiskEngine,
        Authority::Operator,
        Authority::Ceremony,
    ]
    .iter()
    .filter(|held| satisfies(**held, required))
    .count()
}

/// Does this proof carry everything the tier requires?
///
/// Every required authority must be met by a **distinct** authority in the
/// proof. Warm requires `[risk-engine, operator]`, meaning two independent
/// approvals — not "an authority level of at least operator". Without the
/// distinctness rule a lone operator satisfies the operator requirement and,
/// through the hierarchy above, the risk-engine one as well, silently reducing
/// warm from two approvals to one: the entire protection warm exists to give.
///
/// Requirements are matched most-constrained first, which is exact for this
/// nested structure and needs no backtracking.
///
/// Returns the first unmet authority, for an error an operator can act on.
/// Deliberately NOT a risk evaluation: this checks the attestation, not the
/// policy (master-prompt rule 109).
pub fn check_tier_authorization(tier: CustodyTier, approved_by: &str) -> Option<Authority> {
    let mut available = parse_authorities(approved_by);

    let mut ordered: Vec<Authority> = tier.required_authorities().to_vec();
    ordered.sort_by_key(|required| satisfier_count(*required));

    for required in ordered {
        match available.iter().position(|held| satisfies(*held, required)) {
            // Consumed, so one approval cannot count twice.
            Some(index) => {
                available.remove(index);
            }
            None => return Some(required),
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hot_accepts_the_risk_engine_alone() {
        assert!(check_tier_authorization(CustodyTier::Hot, "risk-engine").is_none());
    }

    #[test]
    fn warm_refuses_automation_alone() {
        // The property that makes the tier real: a compromised API can produce
        // a risk-engine proof, but not an operator's signature.
        assert_eq!(
            check_tier_authorization(CustodyTier::Warm, "risk-engine"),
            Some(Authority::Operator)
        );
    }

    #[test]
    fn warm_accepts_both() {
        assert!(
            check_tier_authorization(CustodyTier::Warm, "risk-engine+operator:alice").is_none()
        );
    }

    #[test]
    fn cold_refuses_everything_automated() {
        assert!(
            check_tier_authorization(CustodyTier::Cold, "risk-engine+operator:alice").is_some()
        );
        assert!(check_tier_authorization(CustodyTier::Cold, "ceremony:2026-09-11").is_none());
    }

    #[test]
    fn unknown_authorities_satisfy_nothing() {
        assert!(parse_authorities("superuser+root").is_empty());
        assert!(check_tier_authorization(CustodyTier::Warm, "superuser").is_some());
    }

    #[test]
    fn an_authority_named_as_an_identity_does_not_count() {
        // `operator:risk-engine` names ONE authority, not two.
        assert_eq!(
            parse_authorities("operator:risk-engine"),
            vec![Authority::Operator]
        );
        assert!(check_tier_authorization(CustodyTier::Warm, "operator:risk-engine").is_some());
    }

    #[test]
    fn an_operator_satisfies_a_hot_requirement_alone() {
        // Surfaced by the nonce-provisioning script: an operator acting
        // directly on hot was refused for carrying too MUCH authority, and the
        // obvious workaround would have been a proof falsely claiming
        // `risk-engine`.
        assert!(check_tier_authorization(CustodyTier::Hot, "operator:alice").is_none());
        assert!(check_tier_authorization(CustodyTier::Hot, "ceremony:2026-09-11").is_none());
    }

    #[test]
    fn automation_never_satisfies_a_human_requirement() {
        // The direction that matters: exactly the substitution a compromised
        // coordinator would like to make.
        assert!(check_tier_authorization(CustodyTier::Warm, "risk-engine").is_some());
        assert!(check_tier_authorization(CustodyTier::Cold, "risk-engine").is_some());
    }

    #[test]
    fn a_ceremony_does_not_stand_in_for_a_named_operator() {
        assert_eq!(
            check_tier_authorization(CustodyTier::Warm, "ceremony:2026-09-11"),
            Some(Authority::Operator)
        );
    }

    #[test]
    fn warm_means_two_approvals_not_one_senior_one() {
        // The subtle one. With a naive hierarchy check, `operator` satisfies
        // the operator requirement AND the risk-engine requirement, silently
        // reducing warm from two independent approvals to one — the whole
        // protection warm exists to give.
        assert!(check_tier_authorization(CustodyTier::Warm, "operator:alice").is_some());
        assert!(
            check_tier_authorization(CustodyTier::Warm, "risk-engine+operator:alice").is_none()
        );
        assert!(
            check_tier_authorization(CustodyTier::Warm, "ceremony:2026-09-11+operator:alice")
                .is_none()
        );
        // Hot needs only one, so a single operator is enough there.
        assert!(check_tier_authorization(CustodyTier::Hot, "operator:alice").is_none());
    }

    #[test]
    fn no_two_tiers_share_a_policy() {
        // The executable form of rule 137. Tiers that all sign the same way
        // are labels, and this fails the moment that becomes true.
        let tiers = [
            CustodyTier::Deposit,
            CustodyTier::Hot,
            CustodyTier::Warm,
            CustodyTier::Cold,
        ];
        let mut signatures: Vec<String> = tiers
            .iter()
            .map(|t| {
                let mut names: Vec<&str> = t
                    .required_authorities()
                    .iter()
                    .map(|a| a.as_str())
                    .collect();
                names.sort_unstable();
                format!(
                    "{}|{}|{}",
                    names.join("+"),
                    t.signing_threshold(),
                    t.fixed_destination_only()
                )
            })
            .collect();
        signatures.sort();
        signatures.dedup();
        assert_eq!(signatures.len(), tiers.len());
    }

    #[test]
    fn only_deposit_keys_are_destination_locked() {
        assert!(CustodyTier::Deposit.fixed_destination_only());
        for tier in [CustodyTier::Hot, CustodyTier::Warm, CustodyTier::Cold] {
            assert!(!tier.fixed_destination_only());
        }
    }

    #[test]
    fn deposit_requires_no_authority_because_it_cannot_choose_a_destination() {
        assert!(check_tier_authorization(CustodyTier::Deposit, "").is_none());
    }
}
