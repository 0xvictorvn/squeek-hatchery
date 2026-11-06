import test from "node:test";
import assert from "node:assert/strict";
import {
  accessoryAt,
  accessoryPreview,
  ACCESSORIES,
  validateStatus,
  SignalError,
  palette,
  develop,
  freshSession,
  lockAccessory,
  lampPower,
  lampGeometry,
  positionForRailY,
  colorAlpha,
  hueName,
  workDelta,
  type Reading,
} from "../src/rules.ts";
import { portraitSVG } from "../src/art.ts";
import { buildTraits, metadataJSON, validName } from "../src/metadata.ts";
import { validSession, addDemoEgg, type DemoStore } from "../src/storage.ts";
import { companionOf, hashResult } from "../src/nft.ts";
const now = Date.parse("2026-11-02T00:00:00Z");
const body = (patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  measurement: {
    provenance: "hardware",
    freshness: "online",
    coreStatus: "ACTIVE",
    rpmMilli: 120000,
    distanceMm: 123000,
    cumulativeWorkUnits: "1000",
    counterEpoch: "a",
    receivedAt: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    staleAfterSeconds: 15,
    ...patch,
  },
});
const r = validateStatus(body(), now);
test("only fresh hardware is accepted, including stale observations with a refreshed receipt", () => {
  for (const patch of [
    { provenance: "simulated" },
    { provenance: null },
    { freshness: "offline" },
    { coreStatus: "COUNTER_FAULT" },
    { rpmMilli: -1 },
    { distanceMm: NaN },
    { cumulativeWorkUnits: 1000 },
    { cumulativeWorkUnits: "01" },
    { counterEpoch: "" },
    { staleAfterSeconds: 0 },
    { receivedAt: "no" },
    { observedAt: new Date(now - 16000).toISOString() },
  ])
    assert.throws(() => validateStatus(body(patch), now), SignalError);
  assert.throws(() => validateStatus({}, now), SignalError);
  assert.equal(r.rpm, 120);
  assert.equal(
    validateStatus(body({ cumulativeWorkUnits: "9".repeat(78) }), now).work,
    BigInt("9".repeat(78)),
  );
  assert.throws(
    () => validateStatus(body({ cumulativeWorkUnits: "9".repeat(79) }), now),
    SignalError,
  );
  assert.equal(
    validateStatus(body({ coreStatus: "IDLE", rpmMilli: 999000 }), now).rpm,
    0,
  );
});
test("unchanged fresh ACTIVE and IDLE measurements keep their original reading and add no work", () => {
  for (const coreStatus of ["ACTIVE", "IDLE"]) {
    const payload = body({ coreStatus });
    const baseline = validateStatus(payload, now);
    for (const delay of [0, 4000, 8000, 12000, 15000]) {
      // A refreshed HTTP receipt must not replace the accepted observation or extend its life.
      const unchanged = validateStatus(
        body({ coreStatus, receivedAt: new Date(now + delay).toISOString() }),
        now + delay,
        baseline,
      );
      assert.strictEqual(unchanged, baseline);
      assert.equal(workDelta(baseline, unchanged), 0n);
      assert.equal(unchanged.received, now);
    }
  }
});
test("unchanged measurements still expire and undergo all hardware checks", () => {
  const freshReceipt = { receivedAt: new Date(now + 15001).toISOString() };
  assert.throws(
    () => validateStatus(body(freshReceipt), now + 15001, r),
    (e: unknown) => e instanceof SignalError && e.reason === "stale",
  );
  const shortLimit = validateStatus(body({ staleAfterSeconds: 5 }), now);
  assert.throws(
    () => validateStatus(body({ staleAfterSeconds: 5 }), now + 5001, shortLimit),
    (e: unknown) => e instanceof SignalError && e.reason === "stale",
  );
  for (const patch of [
    { provenance: "simulated" },
    { freshness: "offline" },
    { coreStatus: "COUNTER_FAULT" },
    { rpmMilli: -1 },
    { receivedAt: "invalid" },
  ])
    assert.throws(() => validateStatus(body(patch), now, r), SignalError);
});
test("conflicting equal-time measurements, backwards counters and old observations reject against retained baseline", () => {
  for (const patch of [
    { counterEpoch: "b" },
    { cumulativeWorkUnits: "1001" },
    { cumulativeWorkUnits: "999" },
    { distanceMm: 124000 },
    { distanceMm: 122000 },
    { rpmMilli: 60000 },
    { coreStatus: "IDLE" },
  ])
    assert.throws(
      () => validateStatus(body(patch), now, r),
      (e: unknown) => e instanceof SignalError && e.reason === "replayed",
    );
  for (const patch of [{ cumulativeWorkUnits: "999" }, { distanceMm: 120000 }])
    assert.throws(
      () =>
        validateStatus(
          body({ ...patch, observedAt: new Date(now + 1).toISOString() }),
          now + 1,
          r,
        ),
      SignalError,
    );
  assert.throws(
    () =>
      validateStatus(
        body({
          counterEpoch: "old",
          observedAt: new Date(now - 1).toISOString(),
        }),
        now,
        r,
      ),
    SignalError,
  );
  const reset = validateStatus(
    body({
      counterEpoch: "b",
      cumulativeWorkUnits: "0",
      distanceMm: 0,
      observedAt: new Date(now + 1).toISOString(),
    }),
    now + 1,
    r,
  );
  assert.equal(workDelta(r, reset), 0n);
});
test("ten ordinary accessories rotate exactly, special windows override and resume", () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(accessoryAt(BigInt(i * 50)), i);
    assert.equal(accessoryAt(BigInt(i * 50 + 49)), i);
  }
  for (const start of [1000n, 3000n, 5000n]) {
    assert.equal(accessoryAt(start - 1n), 9);
    assert.equal(accessoryAt(start), 10);
    assert.equal(accessoryAt(start + 49n), 10);
    assert.equal(accessoryAt(start + 50n), 1);
  }
  for (const start of [2000n, 4000n, 6000n]) {
    assert.equal(accessoryAt(start), 11);
    assert.equal(accessoryAt(start + 49n), 11);
    assert.equal(accessoryAt(start + 50n), 1);
  }
  assert.equal(accessoryPreview(1049n).remaining, 1n);
  assert.equal(accessoryPreview(1049n).next, 1);
  assert.equal(accessoryPreview(999n).next, 10);
  assert.equal(
    accessoryAt(900719925474099312345678n),
    Number((900719925474099312345678n / 50n) % 10n),
  );
  assert.equal(accessoryAt(BigInt("9".repeat(78))), 9);
  assert.equal(accessoryPreview(BigInt("9".repeat(78))).remaining, 1n);
  assert.equal(accessoryPreview(BigInt("9".repeat(78))).next, 11);
  assert.throws(() => accessoryAt(-1n));
});
test("accessory locks once; work increments cannot drive growth", () => {
  const s = freshSession("locked");
  lockAccessory(s, r);
  assert.equal(s.accessoryId, 10);
  lockAccessory(s, { ...r, work: 2000n });
  assert.equal(s.accessoryId, 10);
  const a = freshSession("a"),
    b = freshSession("b"),
    c = palette(r.distanceMm, r.utcDate);
  develop(a, 1, 0, c, 0n);
  develop(b, 1, 0, c, 999999999999n);
  assert.deepEqual(a.regions, b.regions);
  assert.deepEqual(a.bands, b.bands);
  assert.equal(a.elapsed, 1);
});
test("color windows are 5m, ordinary every 5m, specials every 500m", () => {
  assert.equal(hueName(0), "Rose");
  assert.equal(hueName(60), "Honey");
  assert.equal(hueName(120), "Leaf");
  assert.equal(hueName(180), "Sea glass");
  assert.equal(hueName(240), "Cornflower");
  for (const m of [250, 750, 1250]) {
    assert.equal(palette(m * 1000, "2026-11-02").kind, "pearl");
    assert.equal(palette((m + 5) * 1000, "2026-11-02").kind, "ordinary");
  }
  for (const m of [500, 1000, 1500]) {
    assert.equal(palette(m * 1000, "2026-11-02").kind, "rainbow");
    assert.equal(palette((m + 5) * 1000, "2026-11-02").kind, "ordinary");
  }
  assert.notEqual(
    palette(0, "2026-11-02").hue,
    palette(5000, "2026-11-02").hue,
  );
  assert.equal(palette(4999, "2026-11-02").remainingMeters, 0.001);
});
test("local intensity times active time controls distinct regions and preserves unlit colors", () => {
  assert.equal(lampPower(0), 0.12);
  assert.equal(lampPower(120), 1);
  assert.equal(lampPower(10000), 1);
  const s = freshSession("local"),
    before = structuredClone(s.bands.at(-1)!);
  s.lampPosition = -70;
  develop(s, 10, 120, palette(250000, "2026-11-02"));
  assert.ok(s.regions[0].growth > 0);
  assert.equal(s.regions[1].growth, 0);
  assert.equal(s.regions[2].growth, 0);
  assert.deepEqual(s.bands.at(-1), before);
  const g = s.regions[0].growth;
  s.lampPosition = 70;
  develop(s, 50, 0, palette(500000, "2026-11-02"));
  assert.equal(s.regions[0].growth, g);
  assert.equal(s.elapsed, 60);
  assert.equal(develop(s, 3, 120, palette(0, "2026-11-02")), true);
  assert.equal(s.elapsed, 60);
  assert.ok(colorAlpha(1e6) <= 0.82);
});
test("lamp stays perpendicular to stationary ellipse, keyboard positions and drag inverse agree", () => {
  for (const p of [-100, -70, 0, 70, 100]) {
    const g = lampGeometry(p),
      [nx, ny] = g.normal;
    assert.ok(
      Math.abs((g.targetX - g.sourceX) * ny - (g.targetY - g.sourceY) * nx) <
        1e-6,
    );
    assert.ok(Math.abs(positionForRailY(g.sourceY) - p) < 0.2);
  }
});
test("one egg card survives incubation and preserves its ID; a new egg can follow", () => {
  const store: DemoStore = { version: 3, selected: null, cards: [] },
    a = addDemoEgg(store);
  assert.equal(addDemoEgg(store).id, a.id);
  assert.equal(store.cards.length, 1);
  a.kind = "hamster";
  a.session.endedAt = "2026-11-02";
  const b = addDemoEgg(store);
  assert.notEqual(a.id, b.id);
  assert.equal(store.cards.length, 2);
  const restored = JSON.parse(JSON.stringify(store));
  assert.equal(restored.cards[0].id, a.id);
  assert.ok(validSession(restored.cards[0].session));
  assert.equal(restored.cards[0].kind, "hamster");
});
test("all twelve accessories render after hatch only and metadata contains no Pattern", () => {
  const outputs = new Set<string>();
  ACCESSORIES.forEach((name, i) => {
    const s = freshSession("accessory-" + i);
    s.accessoryId = i as typeof s.accessoryId;
    const egg = portraitSVG(s);
    s.endedAt = "2026-11-02";
    const svg = portraitSVG(s);
    outputs.add(svg);
    assert.notEqual(egg, svg);
    assert.ok(svg.includes("viewBox="));
    const traits = buildTraits(s);
    assert.ok(traits.includes(name));
    assert.ok(!traits.includes("Pattern"));
    assert.notEqual(svg, portraitSVG(s, false));
  });
  assert.equal(outputs.size, 12);
});
test("export is canonical and result hash binds name, growth, SVG and accessory version", () => {
  const s = freshSession("parity");
  s.elapsed = 60;
  s.endedAt = "2026-11-02T00:00:00Z";
  s.accessoryId = 11;
  const json = JSON.parse(metadataJSON(s, "Pip")),
    result = companionOf(s, "Pip");
  assert.equal(atob(json.image.split(",")[1]), result.svg);
  assert.deepEqual(json.attributes, JSON.parse(result.traits));
  assert.equal(result.svg, portraitSVG(s));
  assert.notEqual(hashResult(result), hashResult({ ...result, name: "Other" }));
  assert.notEqual(
    hashResult(result),
    hashResult({ ...result, accessoryId: 10 }),
  );
});
test("all combinations stay within onchain artifact limits, including full special coat", () => {
  let max = 0;
  for (let i = 0; i < 12; i++) {
    const s = freshSession("size-" + i);
    s.accessoryId = i as typeof s.accessoryId;
    s.endedAt = "2026-11-02";
    s.regions.forEach((r) => (r.growth = 1));
    s.bands.forEach((b) => {
      b.dose = 40;
      b.rainbow = 0.5;
      b.pearl = 0.5;
    });
    const c = companionOf(s, "W".repeat(30));
    max = Math.max(max, new TextEncoder().encode(c.svg).length);
    assert.ok(c.svg.length <= 16000, `${i}: ${c.svg.length}`);
    assert.ok(c.traits.length <= 1500);
  }
  console.log("Largest canonical SVG bytes:", max);
});
test("name and restored-session input bounds prevent unsafe local markup", () => {
  for (const v of ["Pip", "W".repeat(30), "Bean Jr."]) assert.ok(validName(v));
  for (const v of ["", "W".repeat(31), "<script>", " Egg", 'Hamster"'])
    assert.ok(!validName(v));
  const s = freshSession("valid");
  assert.ok(validSession(s));
  assert.ok(!validSession({ ...s, lampPosition: Infinity }));
  assert.ok(!validSession({ ...s, accessoryId: 12 }));
  assert.ok(!validSession({ ...s, bands: [{ y: 'x"', rgb: [] }] }));
});
