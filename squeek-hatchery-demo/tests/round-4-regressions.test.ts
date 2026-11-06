import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHatcheryHttpServer } from "../src/server.ts";
import { EXPERIMENTAL_POLICY_V2 } from "../src/game-policy.ts";
import { createClientTelemetryTracker } from "../src/led-session.ts";
import { measurementDayKey } from "../src/rules.ts";

type StatusDto = {
  dayStartWorkUnits: string;
  updatedAtMs: number;
  reading: Parameters<ReturnType<typeof createClientTelemetryTracker>["ingestBackendReading"]>[0];
};

async function withServer<T>(
  nowRef: { ms: number },
  observedAgeMs: () => number,
  fn: (
    baseUrl: string,
    backend: { pollProducerTick: () => Promise<void> },
  ) => Promise<T>,
): Promise<T> {
  const { backend, server } = createHatcheryHttpServer({
    dbPath: ":memory:",
    policy: EXPERIMENTAL_POLICY_V2,
    now: () => nowRef.ms,
    hardwareProvider: async () => {
      const observed = nowRef.ms - observedAgeMs();
      return {
        reading: {
          coreStatus: "ACTIVE",
          rpm: 65,
          meters: 100,
          distanceMm: 100_000,
          work: 1000n,
          counterEpoch: "r4-epoch",
          installationId: "r4-wheel",
          observedAt: observed,
          received: observed,
          staleAfterSeconds: 60,
          utcDate: measurementDayKey(observed),
        },
        source: "live",
      };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, backend);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    backend.close();
  }
}

test("R14: cached telemetry DTO (updatedAtMs) never extends client freshness; expiry, first light, repeated cached reads, stall and recovery", async () => {
  const base = Date.parse("2026-11-06T13:00:00.000Z");
  const nowRef = { ms: base };
  let observedAge = 10_000;

  await withServer(nowRef, () => observedAge, async (baseUrl, backend) => {
    // Real HTTP DTO -> client tracker boundary, with perfectly synchronized clocks.
    const fetchDto = async (): Promise<StatusDto> =>
      (await (await fetch(`${baseUrl}/api/hardware/status`)).json()) as StatusDto;

    let clientNow = base;
    const tracker = createClientTelemetryTracker({
      now: () => clientNow,
      policy: EXPERIMENTAL_POLICY_V2,
    });

    const first = await fetchDto();
    const ingested = tracker.ingestBackendReading(
      first.reading,
      first.dayStartWorkUnits,
      tracker.beginRequest(),
    );
    assert.equal(ingested.healthy, true, "10s-old reading is initially fresh (first light allowed)");
    assert.equal(first.reading.observedAt, base - 10_000);

    // Same cached DTO, 5.1s later: observation is 15.1s old -> must expire at the original deadline.
    clientNow += 5_100;
    assert.equal(
      tracker.checkFreshnessForStep().healthy,
      false,
      "cached updatedAtMs must not shift the clock and extend freshness",
    );

    // Repeated cached reads (same observedAt/updatedAtMs) must not renew freshness either. The backend
    // itself now rejects the 15.1s-old observation (503); the client must also reject a replayed DTO.
    nowRef.ms = clientNow;
    observedAge = 15_100;
    const staleResponse = await fetch(`${baseUrl}/api/hardware/status`);
    assert.equal(staleResponse.status, 503, "server refuses to serve an expired observation");
    const afterRepeat = tracker.ingestBackendReading(
      first.reading,
      first.dayStartWorkUnits,
      tracker.beginRequest(),
    );
    assert.equal(afterRepeat.healthy, false, "repeated cached response must never renew freshness");
    assert.equal(tracker.checkFreshnessForStep().healthy, false);

    // Stall: no further ingestion; stays unhealthy as time advances.
    clientNow += 30_000;
    nowRef.ms = clientNow;
    assert.equal(tracker.checkFreshnessForStep().healthy, false);

    // Recovery: advance/trigger the independent ~3s producer before expecting a fresh DTO.
    // Changing the fake provider clock alone must not invent a visitor-driven upstream poll.
    observedAge = 0;
    nowRef.ms = clientNow;
    await backend.pollProducerTick();
    const fresh = await fetchDto();
    assert.equal(fresh.reading.observedAt, clientNow);
    const recovered = tracker.ingestBackendReading(
      fresh.reading,
      fresh.dayStartWorkUnits,
      tracker.beginRequest(),
    );
    assert.equal(recovered.healthy, true);
  });
});

test("R15: README asset setup names only files that exist, and the local delivery check works without Git", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /family-[0-2]\.(png|json)/);
  assert.doesNotMatch(readme, /bg-[0-9]\.png/);
  const assets = path.resolve(root, "..", "hamster-trait-lab", "assets");
  for (const name of [
    "families-v2.png",
    "pulse-evolution-v1.png",
    "relay-evolution-v1.png",
    "prism-evolution-v1.png",
  ]) {
    assert.match(readme, new RegExp(name.replace(/\./g, "\\.")));
    assert.ok(fs.existsSync(path.join(assets, name)), `${name} missing`);
  }
  assert.match(readme, /backgrounds\/led\//);
  assert.match(readme, /check-delivery\.mjs/);
  assert.match(readme, /no Git|not a Git|without Git/i);
});
