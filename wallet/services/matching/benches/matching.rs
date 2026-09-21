//! Benchmarks exist so a regression is VISIBLE, not so a number can be
//! advertised. Do not tune the engine against them in this phase, and where a
//! benchmark and a correctness property conflict, the property wins.

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use wallet_matching::types::{
    Command, MarketConfig, MarketStatus, OrderRequest, OrderType, SequencedCommand, Side, StpMode,
    TimeInForce,
};
use wallet_matching::Engine;

const TICK: u64 = 1_000_000;
const LOT: u64 = 1_000_000;

fn market() -> MarketConfig {
    MarketConfig {
        id: "devnet:SOL-USDC".into(),
        tick_size: TICK,
        lot_size: LOT,
        min_notional: 1,
        collar_bps: 1_000_000,
        status: MarketStatus::Open,
    }
}

fn request(account: &str, side: Side, price: Option<u64>, qty: u64) -> OrderRequest {
    OrderRequest {
        client_order_id: format!("c-{account}"),
        side,
        order_type: if price.is_some() {
            OrderType::Limit
        } else {
            OrderType::Market
        },
        time_in_force: TimeInForce::GTC,
        price,
        qty,
        post_only: false,
        stp_mode: StpMode::CancelTaker,
        account_id: account.into(),
    }
}

fn sequenced(seq: u64, command: Command) -> SequencedCommand {
    SequencedCommand {
        seq,
        timestamp_ms: 1_700_000_000_000 + seq as i64,
        command,
    }
}

/// A book with `depth` price levels on each side, far enough apart not to cross.
fn seeded(depth: u64) -> Engine {
    let mut engine = Engine::new(market());
    let mut seq = 0;
    for i in 0..depth {
        seq += 1;
        engine.apply(sequenced(
            seq,
            Command::Place {
                order_id: format!("b-{i}"),
                request: request("mm", Side::Buy, Some((1_000 - i) * TICK), 10 * LOT),
            },
        ));
        seq += 1;
        engine.apply(sequenced(
            seq,
            Command::Place {
                order_id: format!("a-{i}"),
                request: request("mm2", Side::Sell, Some((1_001 + i) * TICK), 10 * LOT),
            },
        ));
    }
    engine
}

fn bench(c: &mut Criterion) {
    let mut group = c.benchmark_group("apply");

    group.bench_function("place_resting_into_empty_book", |b| {
        b.iter_batched_ref(
            || Engine::new(market()),
            |engine| {
                engine.apply(sequenced(
                    1,
                    Command::Place {
                        order_id: "o".into(),
                        request: request("a", Side::Buy, Some(1_000 * TICK), LOT),
                    },
                ))
            },
            BatchSize::SmallInput,
        );
    });

    for depth in [10u64, 100, 1_000] {
        group.bench_function(format!("place_resting_depth_{depth}"), |b| {
            b.iter_batched_ref(
                || seeded(depth),
                |engine| {
                    let seq = engine.last_seq() + 1;
                    engine.apply(sequenced(
                        seq,
                        Command::Place {
                            order_id: "new".into(),
                            request: request("t", Side::Buy, Some(900 * TICK), LOT),
                        },
                    ))
                },
                BatchSize::SmallInput,
            );
        });

        group.bench_function(format!("taker_sweeps_depth_{depth}"), |b| {
            b.iter_batched_ref(
                || seeded(depth),
                |engine| {
                    let seq = engine.last_seq() + 1;
                    engine.apply(sequenced(
                        seq,
                        Command::Place {
                            order_id: "sweep".into(),
                            request: request("t", Side::Buy, Some(2_000 * TICK), 200 * LOT),
                        },
                    ))
                },
                BatchSize::SmallInput,
            );
        });

        group.bench_function(format!("cancel_depth_{depth}"), |b| {
            b.iter_batched_ref(
                || seeded(depth),
                |engine| {
                    let seq = engine.last_seq() + 1;
                    engine.apply(sequenced(
                        seq,
                        Command::Cancel {
                            order_id: format!("b-{}", depth / 2),
                        },
                    ))
                },
                BatchSize::SmallInput,
            );
        });
    }

    // The case the depth benchmarks never reach: many orders queued at ONE
    // price. Finding an order inside its level is the part of cancel that is
    // not a hash lookup, so this is where its real complexity shows.
    for queued in [10u64, 100, 1_000] {
        group.bench_function(format!("cancel_from_level_of_{queued}"), |b| {
            b.iter_batched_ref(
                || {
                    let mut engine = Engine::new(market());
                    for i in 0..queued {
                        engine.apply(sequenced(
                            i + 1,
                            Command::Place {
                                order_id: format!("q-{i}"),
                                request: request(
                                    &format!("a-{i}"),
                                    Side::Buy,
                                    Some(1_000 * TICK),
                                    LOT,
                                ),
                            },
                        ));
                    }
                    engine
                },
                |engine| {
                    let seq = engine.last_seq() + 1;
                    // The LAST in the queue: the worst case for a scan.
                    engine.apply(sequenced(
                        seq,
                        Command::Cancel {
                            order_id: format!("q-{}", queued - 1),
                        },
                    ))
                },
                BatchSize::SmallInput,
            );
        });
    }

    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
