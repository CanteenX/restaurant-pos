import { expect, request, test } from "@playwright/test";

// Real path against the demo stack: the owner (dispatcher) opens the map, a
// freshly created DELIVERY_STAFF rider goes on duty and posts locations, and the
// marker must move via the permission-gated `rider.location` push — no reload.
test("live map moves a rider marker when the rider posts a location", async ({ page, baseURL }) => {
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  const owner = page.request;
  const roles = (await (await owner.get("/api/v1/users/roles")).json()) as { id: string; name: string }[];
  const users = (await (await owner.get("/api/v1/users")).json()) as { email: string; branches: { branch: { id: string } }[] }[];
  const branchId = users.find((u) => u.email === "owner@demo.local")!.branches[0].branch.id;
  const email = `rider-${Date.now()}@demo.local`;
  const created = await owner.post("/api/v1/users", {
    data: { name: "Map Rider", email, password: "Password123!", roleId: roles.find((r) => r.name === "DELIVERY_STAFF")!.id, branchIds: [branchId] },
  });
  expect(created.ok()).toBeTruthy();

  const rider = await request.newContext({ baseURL });
  expect((await rider.post("/api/v1/auth/login", { data: { email, password: "Password123!" } })).ok()).toBeTruthy();
  expect((await rider.post("/api/v1/rider/duty", { data: { online: true } })).ok()).toBeTruthy();
  expect((await rider.post("/api/v1/rider/location", { data: { lat: 12.9716, lng: 77.5946 } })).ok()).toBeTruthy();

  await page.goto("/delivery");
  const item = page.locator('[data-testid^="rider-"][data-lat]').first();
  await expect(item).toHaveAttribute("data-lat", "12.9716");
  const marker = page.locator(".leaflet-marker-icon").first();
  await expect(marker).toBeVisible();
  const before = (await marker.boundingBox())?.x;

  // Live socket push, no reload.
  expect((await rider.post("/api/v1/rider/location", { data: { lat: 13.0827, lng: 80.2707 } })).ok()).toBeTruthy();
  await expect(item).toHaveAttribute("data-lat", "13.0827");
  await expect.poll(async () => (await marker.boundingBox())?.x).not.toBe(before);

  await page.screenshot({ path: "test-results/delivery-map.png" });
  await rider.post("/api/v1/rider/duty", { data: { online: false } });
  await rider.dispose();
});
