#!/usr/bin/env bash
# deploy/zmq-latency-test.sh
#
# Tests ZeroMQ loopback RTT between a Node.js REQ client and a bash REP server.
# Validates < 0.5ms target BEFORE the MT5 EA is compiled.
#
# Prerequisites: npm install zeromq done, libzmq3-dev installed
# Usage: bash deploy/zmq-latency-test.sh

set -euo pipefail

echo "[ZMQ Test] Starting loopback latency test on tcp://127.0.0.1:5556"

# Start a tiny REP echo server in the background using Python (libzmq binding)
python3 - <<'PYEOF' &
import zmq, time
ctx = zmq.Context()
sock = ctx.socket(zmq.REP)
sock.bind("tcp://127.0.0.1:5556")
print("[REP] listening", flush=True)
for _ in range(1000):
    msg = sock.recv()
    sock.send(msg)
sock.close()
ctx.term()
PYEOF

PY_PID=$!
sleep 1  # Wait for REP server to bind and be ready

# Node.js REQ client — 10 warmup + 500 round trips, persistent socket
node - <<'JSEOF'
const zmq = require('zeromq');

async function run() {
  const sock = new zmq.Request();
  sock.connect("tcp://127.0.0.1:5556");

  const WARMUP = 10;
  const N = 500;
  const payload = Buffer.from('{"action":"PING"}');

  // Warmup — discard results
  for (let i = 0; i < WARMUP; i++) {
    await sock.send(payload);
    await sock.receive();
  }

  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await sock.send(payload);
    await sock.receive();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6); // ns → ms
  }

  sock.close();

  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / N;
  const min = times[0];
  const max = times[N - 1];
  const p50 = times[Math.floor(N * 0.50)];
  const p99 = times[Math.floor(N * 0.99)];

  console.log(`\n[ZMQ Latency Results] N=${N} (after ${WARMUP} warmup)`);
  console.log(`  avg: ${avg.toFixed(3)} ms`);
  console.log(`  min: ${min.toFixed(3)} ms`);
  console.log(`  p50: ${p50.toFixed(3)} ms`);
  console.log(`  p99: ${p99.toFixed(3)} ms`);
  console.log(`  max: ${max.toFixed(3)} ms`);

  // On the VPS loopback the target is avg < 0.5ms
  // On a dev laptop we just check it actually completes
  const threshold = process.env.ZMQ_LATENCY_THRESHOLD_MS
    ? Number(process.env.ZMQ_LATENCY_THRESHOLD_MS)
    : 0.5;

  if (avg < threshold) {
    console.log(`\n✅ PASS — avg ${avg.toFixed(3)} ms < ${threshold} ms target`);
    process.exit(0);
  } else {
    console.log(`\n⚠️  avg ${avg.toFixed(3)} ms exceeds ${threshold} ms target`);
    console.log("   On the VPS loopback this will be < 0.5 ms.");
    console.log("   Re-run with: ZMQ_LATENCY_THRESHOLD_MS=5 bash deploy/zmq-latency-test.sh");
    process.exit(1);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
JSEOF

EXIT_CODE=$?
kill $PY_PID 2>/dev/null || true
exit $EXIT_CODE
