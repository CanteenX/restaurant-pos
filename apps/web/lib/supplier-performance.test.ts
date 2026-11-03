import assert from "node:assert/strict";
import { test } from "node:test";
import { describePerformance, formatLeadTime, formatOnTimeRate, onTimeTone } from "./supplier-performance.ts";

test("formatOnTimeRate shows a percentage or a dash when untracked", () => {
  assert.equal(formatOnTimeRate(83.33), "83%");
  assert.equal(formatOnTimeRate(100), "100%");
  assert.equal(formatOnTimeRate(null), "—");
});

test("formatLeadTime pluralises days and handles no data", () => {
  assert.equal(formatLeadTime(1), "1 day");
  assert.equal(formatLeadTime(2.5), "2.5 days");
  assert.equal(formatLeadTime(null), "—");
});

test("onTimeTone grades reliability", () => {
  assert.equal(onTimeTone(95), "good");
  assert.equal(onTimeTone(80), "warn");
  assert.equal(onTimeTone(40), "bad");
  assert.equal(onTimeTone(null), "none");
});

test("describePerformance flags a supplier with no deliveries yet", () => {
  const empty = describePerformance({
    totalPurchaseOrders: 0,
    onTimeDeliveryRate: null, avgLeadTimeDays: null,
  });
  assert.equal(empty.hasDeliveries, false);
  const some = describePerformance({
    totalPurchaseOrders: 3,
    onTimeDeliveryRate: 90, avgLeadTimeDays: 2,
  });
  assert.equal(some.hasDeliveries, true);
});
