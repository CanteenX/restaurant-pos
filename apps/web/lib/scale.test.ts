import assert from "node:assert/strict";
import { test } from "node:test";
import {
  StableWeightDetector,
  SimulatedScale,
  linePriceForWeight,
  parseScaleFrame,
} from "./scale.ts";

test("parses a CAS-style frame (ST,GS,   1.250kg)", () => {
  assert.deepEqual(parseScaleFrame("ST,GS,   1.250kg\r\n"), {
    grams: 1250,
    stable: true,
  });
  assert.deepEqual(parseScaleFrame("US,GS,   0.480kg"), { grams: 480, stable: false });
});

test("parses a Mettler-style frame (S S      1.250 kg) and grams", () => {
  assert.deepEqual(parseScaleFrame("S S      1.250 kg"), { grams: 1250, stable: true });
  assert.deepEqual(parseScaleFrame("S D      0.500 kg"), { grams: 500, stable: false });
  assert.deepEqual(parseScaleFrame("ST,GS,   350g"), { grams: 350, stable: true });
});

test("rejects garbage and negative weights", () => {
  assert.equal(parseScaleFrame(""), null);
  assert.equal(parseScaleFrame("hello"), null);
  assert.equal(parseScaleFrame("ST,GS,  -0.010kg"), null);
});

test("stable detector needs N identical readings within tolerance", () => {
  const d = new StableWeightDetector({ readings: 3, toleranceGrams: 2 });
  assert.equal(d.push(1000), null);
  assert.equal(d.push(1001), null);
  assert.equal(d.push(1000), 1000);
  assert.equal(d.push(1500), null); // moved: restart
  assert.equal(d.push(1500), null);
});

test("stable detector honours scale-reported stability flag", () => {
  const d = new StableWeightDetector({ readings: 2, toleranceGrams: 0 });
  assert.equal(d.push(900, false), null);
  assert.equal(d.push(900, false), null);
  assert.equal(d.push(900, true), 900);
});

test("line price: price per kg minus tare, rounded to 2 dp", () => {
  assert.equal(linePriceForWeight({ pricePerKg: 400, grossGrams: 1250, tareGrams: 250 }), 400);
  assert.equal(linePriceForWeight({ pricePerKg: 99.99, grossGrams: 333, tareGrams: 0 }), 33.3);
  assert.equal(linePriceForWeight({ pricePerKg: 400, grossGrams: 100, tareGrams: 250 }), 0);
});

test("simulator emits frames the parser reads", () => {
  const s = new SimulatedScale();
  s.place(1250);
  const f = parseScaleFrame(s.readFrame());
  assert.deepEqual(f, { grams: 1250, stable: true });
  s.settling(2);
  s.place(700);
  assert.equal(parseScaleFrame(s.readFrame())?.stable, false);
  assert.equal(parseScaleFrame(s.readFrame())?.stable, false);
  assert.equal(parseScaleFrame(s.readFrame())?.stable, true);
});
