import { expect, test } from "@playwright/test";

// The drivers endpoint is mocked so the spec is deterministic; "posting a rider
// location" mutates the mocked server state, and the page picks it up on refetch
// (the live socket push path is covered by the rider-map unit tests and the backend rider.location spec; reload stands in for it here).
test("live map shows riders and moves a marker when the rider location changes", async ({ page }) => {
  let pos = { lat: 12.9716, lng: 77.5946 };
  await page.route("**/delivery/drivers*", (r) =>
    r.fulfill({
      json: [
        {
          id: "rider-e2e", name: "E2E Rider", phone: null, riderOnline: true,
          riderLat: pos.lat, riderLng: pos.lng, riderLocationAt: new Date().toISOString(), activeDeliveries: 1,
        },
      ],
    }),
  );
  // Tiles are not needed (and OSM must not be hit from CI); a failure is the offline fallback path.
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await page.goto("/delivery");
  await expect(page.getByTestId("delivery-map")).toBeVisible();
  const rider = page.getByTestId("rider-rider-e2e");
  await expect(rider).toHaveAttribute("data-lat", "12.9716");

  pos = { lat: 13.0827, lng: 80.2707 };
  await page.reload();
  await expect(page.getByTestId("rider-rider-e2e")).toHaveAttribute("data-lat", "13.0827");
  await expect(page.getByRole("status")).toContainText("Map tiles could not load");
});
