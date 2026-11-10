import { test, expect } from '@playwright/test'

test.describe('Smoke tests', () => {
  test('page loads and shows the map container', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#map')).toBeVisible({ timeout: 15000 })
  })

  test('sidebar renders with search input', async ({ page }) => {
    await page.goto('/')
    const search = page.getByLabel('Søk etter organisasjonsnummer eller navn')
    await expect(search).toBeVisible({ timeout: 10000 })
  })

  test('legend toggle button exists', async ({ page }) => {
    await page.goto('/')
    const legendBtn = page.getByLabel(/fargeforklaring/i)
    await expect(legendBtn).toBeVisible({ timeout: 10000 })
  })

  test('no console errors on initial load', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    })
    await page.goto('/')
    await page.waitForTimeout(3000)
    const filtered = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('service-worker') && !e.includes('pmtiles'),
    )
    expect(filtered).toHaveLength(0)
  })

  test('search input accepts text', async ({ page }) => {
    await page.goto('/')
    const search = page.getByLabel('Søk etter organisasjonsnummer eller navn')
    await search.fill('Oslo')
    await expect(search).toHaveValue('Oslo')
  })

  test('data table toggle exists', async ({ page }) => {
    await page.goto('/')
    const btn = page.getByLabel(/datatabell/i)
    await expect(btn).toBeVisible({ timeout: 10000 })
  })
})
