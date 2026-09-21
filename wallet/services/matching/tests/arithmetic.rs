//! The shared vectors.
//!
//! `packages/types` and this crate implement the same fixed-point arithmetic in
//! two languages. That duplication is permitted ONLY because both decode this
//! file and are asserted to agree (prompt_phase_s1.md rules 76, 137). Change one
//! side without the other and this test fails.

use serde::Deserialize;
use wallet_matching::types::{
    fee_amount, is_multiple_of, notional, BPS_DENOMINATOR, PRICE_SCALE, PRICE_SCALE_EXP,
};

#[derive(Deserialize)]
struct Vectors {
    #[serde(rename = "priceScaleExp")]
    price_scale_exp: u32,
    #[serde(rename = "priceScale")]
    price_scale: String,
    #[serde(rename = "bpsDenominator")]
    bps_denominator: String,
    #[serde(rename = "maxU64")]
    max_u64: String,
    notional: Vec<NotionalCase>,
    #[serde(rename = "notionalOverflow")]
    notional_overflow: Vec<OverflowCase>,
    fee: Vec<FeeCase>,
    #[serde(rename = "isMultipleOf")]
    is_multiple_of: Vec<MultipleCase>,
}

#[derive(Deserialize)]
struct NotionalCase {
    name: String,
    price: String,
    qty: String,
    expected: String,
}

#[derive(Deserialize)]
struct OverflowCase {
    name: String,
    price: String,
    qty: String,
}

#[derive(Deserialize)]
struct FeeCase {
    name: String,
    notional: String,
    bps: u32,
    expected: String,
}

#[derive(Deserialize)]
struct MultipleCase {
    name: String,
    value: String,
    step: String,
    expected: bool,
}

fn vectors() -> Vectors {
    let raw = include_str!("../../../vectors/price-vectors.json");
    serde_json::from_str(raw).expect("vectors decode")
}

#[test]
fn constants_agree_with_the_shared_file() {
    let v = vectors();
    assert_eq!(v.price_scale_exp, PRICE_SCALE_EXP);
    assert_eq!(v.price_scale, PRICE_SCALE.to_string());
    assert_eq!(v.bps_denominator, BPS_DENOMINATOR.to_string());
    assert_eq!(v.max_u64, u64::MAX.to_string());
}

#[test]
fn notional_matches_every_vector() {
    for case in vectors().notional {
        let price: u64 = case.price.parse().expect("price");
        let qty: u64 = case.qty.parse().expect("qty");
        let got = notional(price, qty).expect(&case.name);
        assert_eq!(got.to_string(), case.expected, "{}", case.name);
    }
}

/// The vector named "intermediate exceeds u64 but the result does not" is the
/// one that fails if this crate ever multiplies in u64.
#[test]
fn notional_overflows_are_errors_and_never_wraps() {
    for case in vectors().notional_overflow {
        let price: u64 = case.price.parse().expect("price");
        let qty: u64 = case.qty.parse().expect("qty");
        assert!(notional(price, qty).is_none(), "{}", case.name);
    }
}

#[test]
fn fee_matches_every_vector() {
    for case in vectors().fee {
        let value: u64 = case.notional.parse().expect("notional");
        let got = fee_amount(value, case.bps).expect(&case.name);
        assert_eq!(got.to_string(), case.expected, "{}", case.name);
    }
}

#[test]
fn is_multiple_of_matches_every_vector() {
    for case in vectors().is_multiple_of {
        let value: u64 = case.value.parse().expect("value");
        let step: u64 = case.step.parse().expect("step");
        assert_eq!(is_multiple_of(value, step), case.expected, "{}", case.name);
    }
}
