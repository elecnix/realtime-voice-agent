import { expect, test } from "@playwright/test";

test("baseline app loads and /api/health responds", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Realtime Voice Agent" })).toBeVisible();

  // When the UI loads successfully it fetches /api/health via the Vite proxy.
  // We wait for a stable indicator in the rendered UI: the mic button is enabled
  // once health is loaded and the OpenAI key is present.
  const micButton = page.getByRole("button", { name: /start listening|stop listening/i });
  await expect(micButton).toBeVisible();
  await expect(micButton).toBeEnabled();
});
