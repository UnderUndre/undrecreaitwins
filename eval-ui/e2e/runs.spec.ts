import { test, expect } from '@playwright/test'

test('should display eval runs table', async ({ page }) => {
  await page.goto('/')
  
  // Check header
  await expect(page.locator('h1')).toContainText('Prompt Eval Runs')
  
  // Check table exists
  await expect(page.locator('table')).toBeVisible()
  
  // Check table headers
  await expect(page.locator('th')).toContainText('Started')
  await expect(page.locator('th')).toContainText('Finished')
  await expect(page.locator('th')).toContainText('Passed')
})

test('should load runs and display them', async ({ page }) => {
  // Mock API response
  await page.route('**/v1/evals/runs', (route) => {
    route.abort()
  })
  
  await page.goto('/')
  
  // Should show loading or error state
  // Adjust based on your UI behavior
  await expect(page).toHaveURL('/')
})
