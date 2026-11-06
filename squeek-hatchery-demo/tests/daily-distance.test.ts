import test from "node:test";
import assert from "node:assert/strict";
import {
  measurementDayKey,
  palette,
  SignalError,
  validateStatus,
  workDelta,
} from "../src/rules.ts";
import {
  restoreSignalBaseline,
  serializeSignalBaseline,
} from "../src/signal-cache.ts";

function sample(at: string, distanceMm = 3351326, work = "3817") {
  return {
    schemaVersion: 1,
    measurement: {
      provenance: "hardware",
      freshness: "online",
      coreStatus: "ACTIVE",
      rpmMilli: 65000,
      distanceMm,
      cumulativeWorkUnits: work,
      counterEpoch: "continuous-counter",
      observedAt: at,
      receivedAt: at,
      staleAfterSeconds: 120,
    },
  };
}
const read = (at: string, distance?: number, work?: string) =>
  validateStatus(sample(at, distance, work), Date.parse(at));
const replay = (e: unknown) =>
  e instanceof SignalError && e.reason === "replayed";

test("distance day changes at noon UTC, including month and year boundaries", () => {
  for (const [at, day] of [
    ["2026-11-05T11:59:59.999Z", "2026-11-04"],
    ["2026-11-05T12:00:00.000Z", "2026-11-05"],
    ["2026-11-06T00:00:00.000Z", "2026-11-05"],
    ["2027-01-01T11:59:59.999Z", "2026-12-31"],
    ["2027-01-01T12:00:00.000Z", "2027-01-01"],
  ])
    assert.equal(measurementDayKey(Date.parse(at)), day);
});

test("a daily reset is accepted after 19:00 Vietnam and work continues exactly", () => {
  const before = read("2026-11-05T11:59:59.000Z");
  const at = "2026-11-05T12:00:01.000Z";
  const after = validateStatus(sample(at, 878, "3818"), Date.parse(at), before);
  assert.equal(after.distanceMm, 878);
  assert.equal(after.utcDate, "2026-11-05");
  assert.equal(workDelta(before, after), 1n);
  const nextAt = "2026-11-05T12:00:02.000Z";
  const next = validateStatus(sample(nextAt, 1756, "3819"), Date.parse(nextAt), after);
  assert.equal(workDelta(after, next), 1n);
});

test("idle zero distance at rollover is valid and adds no work", () => {
  const before = read("2026-11-05T11:59:59.000Z");
  const at = "2026-11-05T12:00:01.000Z";
  const payload = sample(at, 0);
  payload.measurement.coreStatus = "IDLE";
  const after = validateStatus(payload, Date.parse(at), before);
  assert.equal(after.rpm, 0);
  assert.equal(workDelta(before, after), 0n);
});

test("UTC midnight does not permit distance rollback or change the color day", () => {
  const before = read("2026-11-05T23:59:59.000Z");
  const at = "2026-11-06T00:00:01.000Z";
  assert.throws(
    () => validateStatus(sample(at, 0), Date.parse(at), before),
    replay,
  );
  const after = validateStatus(sample(at), Date.parse(at), before);
  assert.equal(after.utcDate, before.utcDate);
  assert.deepEqual(
    palette(before.distanceMm, before.utcDate),
    palette(after.distanceMm, after.utcDate),
  );
});

test("daily rollover never permits cumulative work rollback, older or conflicting observations", () => {
  const before = read("2026-11-05T11:59:59.000Z");
  const at = "2026-11-05T12:00:01.000Z";
  assert.throws(
    () => validateStatus(sample(at, 0, "3816"), Date.parse(at), before),
    replay,
  );
  const after = validateStatus(sample(at, 0), Date.parse(at), before);
  assert.throws(
    () => validateStatus(sample(at, 878, "3818"), Date.parse(at), after),
    replay,
  );
  const oldAt = "2026-11-05T11:59:59.000Z";
  assert.throws(
    () => validateStatus(sample(oldAt), Date.parse(at), after),
    replay,
  );
});

test("legacy cached calendar dates are migrated without clearing the replay baseline", () => {
  const before = read("2026-11-05T11:59:59.000Z");
  const legacy = JSON.stringify({ ...before, work: before.work.toString(), utcDate: "2026-11-05" });
  const restored = restoreSignalBaseline(legacy);
  assert.ok(restored);
  assert.equal(restored.utcDate, "2026-11-04");
  assert.equal(restored.work, before.work);
  assert.equal(restored.observedAt, before.observedAt);
  assert.equal(restored.received, before.received);
  const at = "2026-11-05T12:00:01.000Z";
  const after = validateStatus(sample(at, 878, "3818"), Date.parse(at), restored);
  const reloaded = restoreSignalBaseline(serializeSignalBaseline(after));
  assert.deepEqual(reloaded, after);
  assert.equal(workDelta(restored, after), 1n);
  assert.strictEqual(validateStatus(sample(at, 878, "3818"), Date.parse(at), reloaded), reloaded);
  assert.throws(
    () => validateStatus(sample(at, 878, "3818"), Date.parse(at) + 120001, reloaded),
    (e: unknown) => e instanceof SignalError && e.reason === "stale",
  );
});

test("restoring old cache cannot allow a midnight rollback", () => {
  const before = read("2026-11-05T23:59:59.000Z");
  const restored = restoreSignalBaseline(serializeSignalBaseline(before));
  assert.ok(restored);
  const at = "2026-11-06T00:00:01.000Z";
  assert.throws(
    () => validateStatus(sample(at, 0), Date.parse(at), restored),
    replay,
  );
});

test("same-day distance rollback is still rejected and epoch changes add no work", () => {
  const before = read("2026-11-05T13:00:00.000Z");
  const at = "2026-11-05T13:00:01.000Z";
  assert.throws(
    () => validateStatus(sample(at, 0), Date.parse(at), before),
    replay,
  );
  const payload = sample(at, 0, "0");
  payload.measurement.counterEpoch = "new-counter";
  const after = validateStatus(payload, Date.parse(at), before);
  assert.equal(workDelta(before, after), 0n);
});

test("missing or malformed cache is ignored and derived cache fields are rebuilt", () => {
  const before = read("2026-11-05T11:59:59.000Z");
  for (const raw of [null, "{", "[]", "null", '{"work":"1"}'])
    assert.equal(restoreSignalBaseline(raw), null);
  for (const patch of [
    { distanceMm: -1 }, { work: "01" }, { counterEpoch: "" },
    { observedAt: 1e16 }, { received: -1 }, { rpm: -1 },
    { coreStatus: "COUNTER_FAULT" }, { staleAfterSeconds: 0 },
  ])
    assert.equal(
      restoreSignalBaseline(JSON.stringify({ ...before, work: "3817", ...patch })),
      null,
    );
  const restored = restoreSignalBaseline(JSON.stringify({ ...before, work: "3817", meters: -1, utcDate: "broken" }));
  assert.equal(restored?.meters, before.distanceMm / 1000);
  assert.equal(restored?.utcDate, "2026-11-04");
});
