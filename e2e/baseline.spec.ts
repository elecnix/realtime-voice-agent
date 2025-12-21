import { expect, test } from "@playwright/test";

test("baseline app loads and /api/health responds", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Realtime Voice Agent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Server status" })).toBeVisible();

  // When the UI loads successfully it fetches /api/health via the Vite proxy.
  // We wait for a stable indicator in the rendered data.
  await expect(page.getByText("Server time")).toBeVisible();
});
