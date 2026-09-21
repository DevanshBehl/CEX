//! Shared test scaffolding.
//!
//! Each integration test binary compiles this module separately, so a helper
//! used by one and not another is dead code in that binary. That is expected
//! for a shared module and is not a signal worth acting on.
#![allow(dead_code)]

use wallet_matching::types::{
    Command, MarketConfig, MarketStatus, OrderRequest, OrderType, Side, StpMode, TimeInForce,
};

pub fn market() -> MarketConfig {
    MarketConfig {
        id: "devnet:SOL-USDC".into(),
        tick_size: 1_000_000,
        lot_size: 1_000_000,
        min_notional: 1,
        collar_bps: 10_000, // 100%, so the collar does not dominate generated streams
        status: MarketStatus::Open,
    }
}

pub fn request(
    account: &str,
    side: Side,
    price: Option<u64>,
    qty: u64,
    tif: TimeInForce,
) -> OrderRequest {
    OrderRequest {
        client_order_id: format!("c-{account}-{qty}"),
        side,
        order_type: if price.is_some() {
            OrderType::Limit
        } else {
            OrderType::Market
        },
        time_in_force: tif,
        price,
        qty,
        post_only: false,
        stp_mode: StpMode::CancelTaker,
        account_id: account.into(),
    }
}

pub fn place(id: &str, request: OrderRequest) -> Command {
    Command::Place {
        order_id: id.into(),
        request,
    }
}
