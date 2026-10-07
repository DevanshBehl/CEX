/**
 * Metrics (master-prompt rule 171, prompt_phase4.md rules 149, 156).
 *
 * THE TWO RULES THAT SHAPE EVERY DECISION HERE
 *
 * 1. **No user identifiers as labels.** A metric carrying a user id is a
 *    privacy leak that survives in a time-series database long after the
 *    request log has rotated, and it is exported to whatever scrapes it.
 * 2. **No amounts as labels.** An amount is unbounded-cardinality by
 *    definition. A counter labelled with every distinct withdrawal value
 *    creates a new series per withdrawal, and a backend holding a million
 *    series for a thousand users is an outage, not a dashboard.
 *
 * Amounts belong in the ledger, which is built to hold them exactly. Metrics
 * answer "how many, how fast, how often did it fail" — so every label is drawn
 * from a CLOSED set: an asset key from the allowlist, a state from the
 * withdrawal machine, an outcome from a fixed enum.
 *
 * No metrics library. The registry is small, the exposition format is text, and
 * the alternative is a transitive dependency tree inside the process that holds
 * the MPC client credentials.
 */

export type LabelValues = Readonly<Record<string, string>>;

interface Series {
  readonly labels: LabelValues;
  value: number;
}

interface HistogramSeries {
  readonly labels: LabelValues;
  readonly counts: number[];
  sum: number;
  count: number;
}

/**
 * Latency buckets in seconds, chosen for what this system does: sub-second API
 * calls at the low end, and a withdrawal lifecycle measured in tens of seconds
 * because finality takes ~13 (ADR-0006). Buckets stopping at 1s would put
 * every withdrawal in `+Inf` and measure nothing.
 */
const DEFAULT_BUCKETS = [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120] as const;

function keyOf(labels: LabelValues): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ''}`)
    .join(',');
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: LabelValues): string {
  const entries = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escape(labels[k] ?? '')}"`);
  return entries.length > 0 ? `{${entries.join(',')}}` : '';
}

export interface Counter {
  inc(labels?: LabelValues, by?: number): void;
}

export interface Gauge {
  set(value: number, labels?: LabelValues): void;
}

export interface Histogram {
  observe(seconds: number, labels?: LabelValues): void;
  /** Times `fn`, recording the outcome label either way. */
  time<T>(labels: LabelValues, fn: () => Promise<T>): Promise<T>;
}

export interface Metrics {
  counter(name: string, help: string): Counter;
  gauge(name: string, help: string): Gauge;
  histogram(name: string, help: string, buckets?: readonly number[]): Histogram;
  /** Prometheus text exposition format. */
  render(): string;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, { help: string; series: Map<string, Series> }>();
  const gauges = new Map<string, { help: string; series: Map<string, Series> }>();
  const histograms = new Map<
    string,
    { help: string; buckets: readonly number[]; series: Map<string, HistogramSeries> }
  >();

  return {
    counter(name, help) {
      const entry = counters.get(name) ?? { help, series: new Map<string, Series>() };
      counters.set(name, entry);
      return {
        inc(labels = {}, by = 1) {
          const key = keyOf(labels);
          const existing = entry.series.get(key);
          if (existing) existing.value += by;
          else entry.series.set(key, { labels, value: by });
        },
      };
    },

    gauge(name, help) {
      const entry = gauges.get(name) ?? { help, series: new Map<string, Series>() };
      gauges.set(name, entry);
      return {
        set(value, labels = {}) {
          entry.series.set(keyOf(labels), { labels, value });
        },
      };
    },

    histogram(name, help, buckets = DEFAULT_BUCKETS) {
      const entry = histograms.get(name) ?? {
        help,
        buckets,
        series: new Map<string, HistogramSeries>(),
      };
      histograms.set(name, entry);

      const observe = (seconds: number, labels: LabelValues = {}): void => {
        const key = keyOf(labels);
        let series = entry.series.get(key);
        if (!series) {
          series = {
            labels,
            counts: new Array<number>(entry.buckets.length).fill(0),
            sum: 0,
            count: 0,
          };
          entry.series.set(key, series);
        }

        for (const [index, bound] of entry.buckets.entries()) {
          if (seconds <= bound) series.counts[index] = (series.counts[index] ?? 0) + 1;
        }
        series.sum += seconds;
        series.count += 1;
      };

      return {
        observe,
        async time(labels, fn) {
          const started = process.hrtime.bigint();
          try {
            const result = await fn();
            observe(Number(process.hrtime.bigint() - started) / 1e9, {
              ...labels,
              outcome: 'success',
            });
            return result;
          } catch (error) {
            // A failure that is not recorded makes the success rate a lie.
            observe(Number(process.hrtime.bigint() - started) / 1e9, {
              ...labels,
              outcome: 'failure',
            });
            throw error;
          }
        },
      };
    },

    render() {
      const lines: string[] = [];

      for (const [name, entry] of counters) {
        lines.push(`# HELP ${name} ${entry.help}`, `# TYPE ${name} counter`);
        for (const series of entry.series.values()) {
          lines.push(`${name}${renderLabels(series.labels)} ${String(series.value)}`);
        }
      }

      for (const [name, entry] of gauges) {
        lines.push(`# HELP ${name} ${entry.help}`, `# TYPE ${name} gauge`);
        for (const series of entry.series.values()) {
          lines.push(`${name}${renderLabels(series.labels)} ${String(series.value)}`);
        }
      }

      for (const [name, entry] of histograms) {
        lines.push(`# HELP ${name} ${entry.help}`, `# TYPE ${name} histogram`);
        for (const series of entry.series.values()) {
          for (const [index, bound] of entry.buckets.entries()) {
            lines.push(
              `${name}_bucket${renderLabels({ ...series.labels, le: String(bound) })} ${String(
                series.counts[index] ?? 0,
              )}`,
            );
          }
          lines.push(
            `${name}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${String(
              series.count,
            )}`,
            `${name}_sum${renderLabels(series.labels)} ${String(series.sum)}`,
            `${name}_count${renderLabels(series.labels)} ${String(series.count)}`,
          );
        }
      }

      return `${lines.join('\n')}\n`;
    },
  };
}

/**
 * The metrics this application records, named in one place so the label sets
 * are reviewable together — which is how rule 156 stays enforced rather than
 * merely remembered.
 */
export interface WalletMetrics {
  readonly registry: Metrics;
  /** labels: asset, outcome */
  readonly deposits: Counter;
  /** labels: asset, state */
  readonly withdrawals: Counter;
  /** labels: stage */
  readonly failures: Counter;
  /** labels: operation, outcome */
  readonly latency: Histogram;
  /** labels: queue */
  readonly queueDepth: Gauge;
  /** labels: queue */
  readonly deadLettered: Counter;
  /** labels: market, outcome (applied | duplicate | halted) */
  readonly settlementEvents: Counter;
  /** Engine timestamp to settlement commit. labels: market */
  readonly settlementLatency: Histogram;
  /**
   * Sequences between the engine and the settled offset. labels: market.
   * THE settlement health signal: a worker that is up and not advancing is
   * worse than one that is down, because nothing alerts on "up".
   */
  readonly settlementLag: Gauge;
  /** labels: market */
  readonly settlementHalts: Counter;
  /** labels: market */
  readonly fillsSettled: Counter;
  /** Quote base units. labels: asset */
  readonly feesAccrued: Counter;
  /** 1 = clean, 0 = drifting, -1 = inconclusive. labels: check, subject */
  readonly reconciliationCheck: Gauge;
  /** Open WebSocket connections. No labels: a user is not a label. */
  readonly socketsOpen: Gauge;
  /** labels: channel */
  readonly socketSubscriptions: Gauge;
  /** labels: channel */
  readonly socketMessages: Counter;
  /** labels: reason (slow_consumer | limit | session_ended | protocol_error | shutdown) */
  readonly socketsClosed: Counter;
  /** labels: reason (origin | session | user_limit | ip_limit) */
  readonly socketUpgradesRefused: Counter;
  /** labels: market, cause */
  readonly bookResyncs: Counter;
  /**
   * Engine sequences the live book has not applied. labels: market.
   * With `marketDataLag`, THE market-data health signal: a reader that is up
   * and not advancing is worse than one that is down.
   */
  readonly fanoutLag: Gauge;
  /** Engine sequences the persisted tape has not recorded. labels: market */
  readonly marketDataLag: Gauge;
  /** labels: market */
  readonly marketDataHalts: Counter;
  /** labels: market */
  readonly tradesRecorded: Counter;
  /** labels: market, outcome (placed | cancelled | rejected | skipped) */
  readonly makerQuotes: Counter;
  /** Milliseconds since the maker's reference price was observed. labels: market */
  readonly makerReferenceAge: Gauge;
}

export function createWalletMetrics(registry: Metrics = createMetrics()): WalletMetrics {
  return {
    registry,
    deposits: registry.counter('wallet_deposits_total', 'Deposits seen, by asset and outcome.'),
    withdrawals: registry.counter(
      'wallet_withdrawals_total',
      'Withdrawal state transitions, by asset and state.',
    ),
    failures: registry.counter('wallet_failures_total', 'Operations that failed, by stage.'),
    latency: registry.histogram(
      'wallet_operation_duration_seconds',
      'Operation latency, by operation and outcome.',
    ),
    queueDepth: registry.gauge('wallet_queue_depth', 'Items awaiting processing, by queue.'),
    deadLettered: registry.counter(
      'wallet_dead_lettered_total',
      'Jobs moved to the dead-letter queue, by queue.',
    ),
    settlementEvents: registry.counter(
      'settlement_events_total',
      'Engine events processed by settlement, by market and outcome.',
    ),
    settlementLatency: registry.histogram(
      'settlement_latency_seconds',
      'Engine timestamp to settlement commit, by market.',
    ),
    settlementLag: registry.gauge(
      'settlement_offset_lag_sequences',
      'Engine sequences not yet settled, by market.',
    ),
    settlementHalts: registry.counter(
      'settlement_halts_total',
      'Settlement workers halted at an unsettleable event, by market.',
    ),
    fillsSettled: registry.counter('settlement_fills_total', 'Fills settled, by market.'),
    feesAccrued: registry.counter(
      'settlement_fees_accrued_base_units_total',
      'Trading fees credited to house_trading_fees, by quote asset.',
    ),
    reconciliationCheck: registry.gauge(
      'reconciliation_check_result',
      'Last result of each clearing-tier check: 1 clean, 0 drift, -1 inconclusive.',
    ),
    socketsOpen: registry.gauge('ws_sockets_open', 'Open WebSocket connections.'),
    socketSubscriptions: registry.gauge('ws_subscriptions', 'Live subscriptions, by channel.'),
    socketMessages: registry.counter('ws_messages_sent_total', 'Messages sent, by channel.'),
    socketsClosed: registry.counter(
      'ws_sockets_closed_total',
      'Sockets closed by the server, by reason.',
    ),
    socketUpgradesRefused: registry.counter(
      'ws_upgrades_refused_total',
      'WebSocket upgrades refused, by reason.',
    ),
    bookResyncs: registry.counter(
      'market_data_book_resyncs_total',
      'Book mirrors discarded and rebuilt from a snapshot, by market and cause.',
    ),
    fanoutLag: registry.gauge(
      'market_data_fanout_lag_sequences',
      'Engine sequences the live book has not applied, by market.',
    ),
    marketDataLag: registry.gauge(
      'market_data_offset_lag_sequences',
      'Engine sequences the persisted trade tape has not recorded, by market.',
    ),
    marketDataHalts: registry.counter(
      'market_data_halts_total',
      'Trade-tape consumers halted at an event they cannot record, by market.',
    ),
    tradesRecorded: registry.counter('market_data_trades_total', 'Trades recorded, by market.'),
    makerQuotes: registry.counter(
      'market_maker_quotes_total',
      'Market-maker quote actions, by market and outcome.',
    ),
    makerReferenceAge: registry.gauge(
      'market_maker_reference_age_ms',
      'Age of the market maker reference price, by market.',
    ),
  };
}
