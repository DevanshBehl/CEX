//! The order book: price-time priority, and nothing else.
//!
//! One book per market, one engine per book, single-threaded. That is a
//! correctness decision rather than a performance one — a single thread makes
//! execution order total and therefore reproducible, which is what every
//! property in this crate depends on.

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::types::{OrderId, Price, Qty, Seq, Side, StpMode};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestingOrder {
    pub order_id: OrderId,
    pub account_id: String,
    pub side: Side,
    pub price: Price,
    pub remaining: Qty,
    pub stp_mode: StpMode,
    /// The sequence at which this order came to rest.
    ///
    /// Carried so price-time priority is CHECKABLE rather than merely true by
    /// construction: within a level the queue must be strictly increasing in
    /// this field, and a property test asserts it after every command.
    pub rested_at_seq: u64,
}

/// A price level. The queue IS price-time priority — arrival order, never a
/// sort.
///
/// The queue may hold TOMBSTONES: ids of orders that have been cancelled and
/// removed from the index but not yet from this queue. That is what makes a
/// cancel O(1) — it decrements the level total and forgets the order, without
/// scanning to find its position. Tombstones are pruned lazily from the front
/// during matching, and a level is dropped outright once its live quantity
/// reaches zero, so a fully-cancelled level does not linger.
///
/// `total_qty` counts LIVE orders only. A level present in a ladder therefore
/// always has live quantity, which is what keeps `best_price` honest.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Level {
    queue: VecDeque<OrderId>,
    /// Maintained incrementally. `u128` because a sum of `u64` quantities is
    /// not itself bounded by `u64`.
    total_qty: u128,
}

impl Level {
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn total_qty(&self) -> u128 {
        self.total_qty
    }

    pub fn front(&self) -> Option<&OrderId> {
        self.queue.front()
    }

    pub fn iter(&self) -> impl Iterator<Item = &OrderId> {
        self.queue.iter()
    }
}

/// One side of the book.
///
/// The traversal direction lives HERE and nowhere else. Encoding it once is the
/// difference between a rule and a thing every call site has to remember.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ladder {
    side: Side,
    levels: BTreeMap<Price, Level>,
}

impl Ladder {
    pub fn new(side: Side) -> Self {
        Self {
            side,
            levels: BTreeMap::new(),
        }
    }

    pub fn side(&self) -> Side {
        self.side
    }

    /// Bids descend from the highest price, asks ascend from the lowest.
    pub fn best_price(&self) -> Option<Price> {
        match self.side {
            Side::Buy => self.levels.keys().next_back().copied(),
            Side::Sell => self.levels.keys().next().copied(),
        }
    }

    pub fn level(&self, price: Price) -> Option<&Level> {
        self.levels.get(&price)
    }

    pub fn is_empty(&self) -> bool {
        self.levels.is_empty()
    }

    pub fn depth(&self) -> usize {
        self.levels.len()
    }

    /// Price levels from the best outward. A snapshot walks this; matching does
    /// not, because matching mutates as it goes.
    pub fn iter_from_best(&self) -> Box<dyn Iterator<Item = (&Price, &Level)> + '_> {
        match self.side {
            Side::Buy => Box::new(self.levels.iter().rev()),
            Side::Sell => Box::new(self.levels.iter()),
        }
    }

    fn push_back(&mut self, price: Price, order_id: OrderId, qty: Qty) {
        let level = self.levels.entry(price).or_default();
        level.queue.push_back(order_id);
        level.total_qty += u128::from(qty);
    }

    /// Reduce the resting quantity at a level, dropping the level if it empties.
    ///
    /// An empty level left in the map changes what "the best price" means and is
    /// a crossed-book bug waiting for the right input.
    fn reduce(&mut self, price: Price, qty: Qty) {
        let drop_level = match self.levels.get_mut(&price) {
            Some(level) => {
                level.total_qty = level.total_qty.saturating_sub(u128::from(qty));
                // Live quantity gone: whatever ids remain in the queue are
                // tombstones, and a level with no live quantity must not stay
                // in the ladder or `best_price` would name a price nothing can
                // trade at.
                level.total_qty == 0
            }
            None => false,
        };
        if drop_level {
            self.levels.remove(&price);
        }
    }

    fn pop_front(&mut self, price: Price) {
        let drop_level = match self.levels.get_mut(&price) {
            Some(level) => {
                level.queue.pop_front();
                level.queue.is_empty()
            }
            None => false,
        };
        if drop_level {
            self.levels.remove(&price);
        }
    }

    /// Forget a cancelled order in O(1).
    ///
    /// The id stays in the queue as a tombstone; only the live total moves. A
    /// scan to find and splice out its position would make cancel O(k) in the
    /// depth of the level, which is precisely the cost this avoids.
    fn forget(&mut self, price: Price, qty: Qty) {
        let drop_level = match self.levels.get_mut(&price) {
            Some(level) => {
                level.total_qty = level.total_qty.saturating_sub(u128::from(qty));
                level.total_qty == 0
            }
            None => false,
        };
        if drop_level {
            // Everything left is a tombstone.
            self.levels.remove(&price);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderBook {
    bids: Ladder,
    asks: Ladder,
    /// An INDEX into the book, never a second copy of it.
    ///
    /// The one permitted `HashMap`, because it is only ever looked up by key
    /// and never iterated in a path that reaches an event. A `HashMap` iterated
    /// where output depends on it is a determinism bug.
    orders: HashMap<OrderId, RestingOrder>,
    last_trade_price: Option<Price>,
}

impl Default for OrderBook {
    fn default() -> Self {
        Self::new()
    }
}

impl OrderBook {
    pub fn new() -> Self {
        Self {
            bids: Ladder::new(Side::Buy),
            asks: Ladder::new(Side::Sell),
            orders: HashMap::new(),
            last_trade_price: None,
        }
    }

    pub fn bids(&self) -> &Ladder {
        &self.bids
    }

    pub fn asks(&self) -> &Ladder {
        &self.asks
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.bids.best_price()
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.asks.best_price()
    }

    pub fn last_trade_price(&self) -> Option<Price> {
        self.last_trade_price
    }

    pub fn set_last_trade_price(&mut self, price: Price) {
        self.last_trade_price = Some(price);
    }

    pub fn get(&self, order_id: &str) -> Option<&RestingOrder> {
        self.orders.get(order_id)
    }

    pub fn contains(&self, order_id: &str) -> bool {
        self.orders.contains_key(order_id)
    }

    pub fn open_order_count(&self) -> usize {
        self.orders.len()
    }

    /// Total resting quantity, for the conservation property.
    pub fn resting_qty(&self) -> u128 {
        self.orders
            .values()
            .map(|order| u128::from(order.remaining))
            .sum()
    }

    fn ladder(&mut self, side: Side) -> &mut Ladder {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    pub fn ladder_for(&self, side: Side) -> &Ladder {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    /// Rest an order. The caller has already established it does not cross.
    pub fn rest(&mut self, order: RestingOrder) {
        let (price, qty, side) = (order.price, order.remaining, order.side);
        let id = order.order_id.clone();
        self.orders.insert(id.clone(), order);
        self.ladder(side).push_back(price, id, qty);
        debug_assert!(self.invariants_hold());
    }

    /// The front LIVE resting order at a price, pruning tombstones as it goes.
    ///
    /// Takes `&mut self` because pruning is the point: leaving cancelled ids at
    /// the head of a queue would make every subsequent match walk them again.
    pub fn front_live(&mut self, side: Side, price: Price) -> Option<RestingOrder> {
        loop {
            let front = self
                .ladder_for(side)
                .level(price)
                .and_then(|level| level.front())
                .cloned()?;
            match self.orders.get(&front) {
                Some(order) => return Some(order.clone()),
                None => self.ladder(side).pop_front(price),
            }
        }
    }

    /// The live orders resting at a price, in queue order. Tombstones excluded.
    pub fn live_ids_at(&self, side: Side, price: Price) -> Vec<OrderId> {
        match self.ladder_for(side).level(price) {
            Some(level) => level
                .iter()
                .filter(|id| self.orders.contains_key(*id))
                .cloned()
                .collect(),
            None => Vec::new(),
        }
    }

    /// Every live resting order id, best price outward, both sides.
    pub fn live_ids(&self) -> Vec<OrderId> {
        let mut ids = Vec::new();
        for ladder in [&self.bids, &self.asks] {
            for (_, level) in ladder.iter_from_best() {
                ids.extend(
                    level
                        .iter()
                        .filter(|id| self.orders.contains_key(*id))
                        .cloned(),
                );
            }
        }
        ids
    }

    /// Consume `qty` from the front order at `price`, removing it when filled.
    ///
    /// Returns the order as it stood before the reduction.
    pub fn consume_front(&mut self, side: Side, price: Price, qty: Qty) -> Option<RestingOrder> {
        let before = self.front_live(side, price)?;
        let id = before.order_id.clone();
        let remaining = before.remaining.saturating_sub(qty);

        // `reduce` may drop the level outright, in which case `pop_front`
        // below is a no-op — which is correct, since the queue went with it.
        self.ladder(side).reduce(price, qty);
        if remaining == 0 {
            self.orders.remove(&id);
            self.ladder(side).pop_front(price);
        } else if let Some(order) = self.orders.get_mut(&id) {
            order.remaining = remaining;
        }
        debug_assert!(self.invariants_hold());
        Some(before)
    }

    /// Remove a resting order wherever it sits. Returns it if it was there.
    pub fn remove(&mut self, order_id: &str) -> Option<RestingOrder> {
        let order = self.orders.remove(order_id)?;
        self.ladder(order.side).forget(order.price, order.remaining);
        debug_assert!(self.invariants_hold());
        Some(order)
    }

    /// Recompute what is maintained incrementally and compare.
    ///
    /// Cheap in tests, absent in release. It is the thing that catches a level
    /// total drifting from its queue, which is otherwise invisible until a
    /// depth snapshot looks wrong.
    pub fn invariants_hold(&self) -> bool {
        let mut live_in_ladders: usize = 0;
        for ladder in [&self.bids, &self.asks] {
            for (price, level) in ladder.levels.iter() {
                let mut recomputed: u128 = 0;
                let mut live_here: usize = 0;
                let mut previous_seq: Option<Seq> = None;
                for id in level.queue.iter() {
                    // Absent from the index means a tombstone, which is legal.
                    let Some(order) = self.orders.get(id) else {
                        continue;
                    };
                    if order.price != *price || order.side != ladder.side {
                        return false; // index and ladder disagree
                    }
                    recomputed += u128::from(order.remaining);
                    live_here += 1;
                    // Price-time priority: the queue is arrival order.
                    if let Some(previous) = previous_seq {
                        if order.rested_at_seq < previous {
                            return false;
                        }
                    }
                    previous_seq = Some(order.rested_at_seq);
                }
                // A level with no live quantity must have been dropped.
                if live_here == 0 || recomputed == 0 {
                    return false;
                }
                if recomputed != level.total_qty {
                    return false;
                }
                live_in_ladders += live_here;
            }
        }
        if let (Some(bid), Some(ask)) = (self.best_bid(), self.best_ask()) {
            if bid >= ask {
                return false; // the book is crossed
            }
        }
        // Every indexed order is live in exactly one ladder. Counted over LIVE
        // entries, not queue length: a queue legitimately holds tombstones.
        self.orders.len() == live_in_ladders
    }
}
