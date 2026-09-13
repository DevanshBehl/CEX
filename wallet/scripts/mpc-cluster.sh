#!/usr/bin/env bash
#
# Stand up a 3-of-5 FROST deployment locally: five participants and one
# coordinator (ADR-0015).
#
# DEVELOPMENT ONLY. Five processes on one machine is five copies of one blast
# radius — the whole point of a threshold is five failure domains, and this has
# one. It exists so the segregated withdrawal path can be exercised end to end
# without provisioning five hosts, and the runbook says what a real ceremony
# requires (docs/runbooks/key-ceremony.md).
#
#   ./scripts/mpc-cluster.sh start   # writes scripts/.mpc-cluster.env
#   ./scripts/mpc-cluster.sh stop
#
# Source the generated env file to point the API at the coordinator.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${MPC_CLUSTER_STATE:-/tmp/atlas-mpc-cluster}"
ENV_FILE="$ROOT/scripts/.mpc-cluster.env"
BIN="$ROOT/services/mpc/target/release/wallet-mpc"
COORD_PORT="${MPC_COORDINATOR_PORT:-7070}"
BASE_PORT="${MPC_PARTICIPANT_BASE_PORT:-7071}"
KEY_REF="${MPC_BOOTSTRAP_KEY_REF:-treasury-hot-1}"

start() {
  [ -x "$BIN" ] || { echo "build first: cargo build --release --manifest-path services/mpc/Cargo.toml"; exit 1; }
  stop >/dev/null 2>&1 || true

  # A port already in use is the failure worth catching here.
  #
  # Without this the coordinator starts, provisions a house key, fails to bind,
  # and exits — while something ELSE answers on that port. Every subsequent
  # request is then authenticated against the wrong service's caller key, and
  # the symptom is `UNAUTHENTICATED` with nothing pointing at the cause. That
  # happened; this is why it cannot happen twice.
  for port in "$COORD_PORT" $(seq "$BASE_PORT" $((BASE_PORT + 4))); do
    if lsof -ti ":$port" >/dev/null 2>&1; then
      echo "port $port is already in use by pid $(lsof -ti ":$port" | head -1)" >&2
      exit 1
    fi
  done

  # A participant seals its share under a KEK generated per start, so a store
  # left over from a previous run is undecryptable. Wiped rather than reused.
  rm -rf "$STATE"
  mkdir -p "$STATE"

  # --- keys -----------------------------------------------------------------
  #
  # The coordinator's caller key is what participants authenticate: its PUBLIC
  # half becomes every participant's MPC_CALLER_PUBLIC_KEY. The API's caller
  # key is separate and only the coordinator trusts it.
  # Written to a file rather than passed with `node -e`: the program contains
  # both quote characters, and threading them through a nested `$( )` is how a
  # key-generation script comes to fail in a way nobody reads.
  cat > "$STATE/keys.cjs" <<'JS'
const { generateKeyPairSync, randomBytes, createPrivateKey, createPublicKey } = require('node:crypto');

const ed = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    pem: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
};

const api = ed();
const approval = ed();

// The coordinator signs with a raw 32-byte seed, not a PEM. Its public half is
// derived here so the operator never has to.
const seed = randomBytes(32);
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const pub = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }))
  .export({ type: 'spki', format: 'der' })
  .subarray(-32);

console.log('API_PRIV=' + api.pem);
console.log('API_PUB=' + api.raw);
console.log('APPROVAL_PRIV=' + approval.pem);
console.log('APPROVAL_PUB=' + approval.raw);
console.log('COORD_SEED=' + seed.toString('base64'));
console.log('COORD_PUB=' + pub.toString('base64'));
JS
  eval "$(node "$STATE/keys.cjs")"
  rm -f "$STATE/keys.cjs"

  # --- participants ---------------------------------------------------------
  #
  # Identifiers 1..5 as FROST encodes them: a 32-byte little-endian scalar,
  # hex. The coordinator matches shares to roster entries BY identifier, so
  # these must be the real encoding rather than "01".
  ROSTER=""
  for i in 1 2 3 4 5; do
    port=$((BASE_PORT + i - 1))
    id=$(printf '%02x' "$i")$(printf '0%.0s' $(seq 1 62))
    kek=$(openssl rand -base64 32)
    echo "$kek" > "$STATE/kek-$i"

    MPC_ROLE=participant \
    MPC_PARTICIPANT_IDENTIFIER="$id" \
    MPC_KEK="$kek" \
    MPC_CALLER_PUBLIC_KEY="$COORD_PUB" \
    MPC_APPROVAL_PUBLIC_KEY="$APPROVAL_PUB" \
    MPC_DATABASE_PATH="$STATE/participant-$i.sqlite" \
    MPC_BOOTSTRAP_KEY_REF="$KEY_REF" \
    MPC_BIND="127.0.0.1:$port" \
    MPC_LOG=info \
      "$BIN" > "$STATE/participant-$i.log" 2>&1 &
    echo $! > "$STATE/participant-$i.pid"

    ROSTER="${ROSTER:+$ROSTER,}$id@http://127.0.0.1:$port"
  done

  for i in 1 2 3 4 5; do
    port=$((BASE_PORT + i - 1))
    for _ in $(seq 1 40); do
      curl -sf "http://127.0.0.1:$port/v1/health" | grep -q '"status":"ok"' && break
      sleep 0.25
    done
  done

  # --- coordinator ----------------------------------------------------------
  MPC_ROLE=coordinator \
  MPC_PARTICIPANTS="$ROSTER" \
  MPC_COORDINATOR_KEY="$COORD_SEED" \
  MPC_KEK="$(openssl rand -base64 32)" \
  MPC_CALLER_PUBLIC_KEY="$API_PUB" \
  MPC_APPROVAL_PUBLIC_KEY="$APPROVAL_PUB" \
  MPC_DATABASE_PATH="$STATE/coordinator.sqlite" \
  MPC_BOOTSTRAP_KEY_REF="$KEY_REF" \
  MPC_BIND="127.0.0.1:$COORD_PORT" \
  MPC_LOG=info \
    "$BIN" > "$STATE/coordinator.log" 2>&1 &
  echo $! > "$STATE/coordinator.pid"

  ready=""
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$COORD_PORT/v1/health" | grep -q '"status":"ok"'; then
      ready=yes
      break
    fi
    sleep 0.5
  done
  if [ -z "$ready" ]; then
    echo "coordinator never became healthy; see $STATE/coordinator.log" >&2
    tail -5 "$STATE/coordinator.log" >&2
    exit 1
  fi

  TREASURY=$(curl -sf "http://127.0.0.1:$COORD_PORT/v1/health" >/dev/null && \
    grep -o '"address":"[^"]*"' "$STATE/coordinator.log" | head -1 | cut -d'"' -f4)

  cat > "$ENV_FILE" <<EOF
# Generated by scripts/mpc-cluster.sh — development only.
export SIGNER_KIND=real
export SEGREGATED_CUSTODY=true
export MPC_ENDPOINT=http://127.0.0.1:$COORD_PORT
export MPC_CLIENT_PRIVATE_KEY=$API_PRIV
export MPC_APPROVAL_PRIVATE_KEY=$APPROVAL_PRIV
export SIGNER_KEY_REF=$KEY_REF
export TREASURY_ADDRESS=$TREASURY
EOF

  echo "coordinator  http://127.0.0.1:$COORD_PORT"
  echo "participants $ROSTER"
  echo "treasury     $TREASURY"
  echo "env          $ENV_FILE"
}

stop() {
  for f in "$STATE"/*.pid; do
    [ -f "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  echo "stopped"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop"; exit 1 ;;
esac
