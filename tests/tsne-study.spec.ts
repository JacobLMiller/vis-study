import { test, expect } from '@playwright/test';
import { nextClick, resetClientStudyState } from './utils';

// Screen size from the pilot that showed a scrollbar in the hyperbolic view
test.use({ viewport: { width: 1920, height: 768 } });

test('tsne study: training pages, practice question, and hyperbolic controls', async ({ page }) => {
  await resetClientStudyState(page);
  await page.goto('/tsne');

  // Introduction
  await expect(page.getByText('Welcome to our Study')).toBeVisible();
  await nextClick(page);

  // Consent
  await page.getByRole('radio', { name: 'yes', exact: true }).check();
  await nextClick(page);

  // Demographics: the three familiarity questions are required
  const newToMe = page.getByRole('radio', { name: 'It is new to me' });
  await newToMe.nth(0).check();
  await newToMe.nth(1).check();
  await newToMe.nth(2).check();
  await nextClick(page);

  // Training page (order between the two techniques is counterbalanced)
  const trainingHeading = page.getByRole('heading', { name: /Training: (Hierarchical SNE|Hyperbolic t-SNE)/ });
  await expect(trainingHeading).toBeVisible();
  const isHyperbolic = (await trainingHeading.textContent())?.includes('Hyperbolic') ?? false;

  // The example screenshot must actually load
  const screenshot = page.getByRole('main').getByRole('img').first();
  await expect(screenshot).toBeVisible();
  await expect.poll(() => screenshot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await nextClick(page);

  // Practice page: only the acknowledgement option, none of the base component's cluster options
  await expect(page.getByText('I have explored the visualization and am ready to continue.')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Continue' })).toHaveCount(1);
  await expect(page.getByRole('radio', { name: '3', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'I am unable to work this out' })).toHaveCount(0);

  if (isHyperbolic) {
    const frame = page.frameLocator('#root iframe');
    await expect(frame.getByRole('button', { name: 'Restore original view' })).toBeVisible();

    // The viewer must fit inside the iframe without its own scrollbar
    const overflow = await frame.locator('body').evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollHeight - el.clientHeight;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  }

  await page.getByRole('radio', { name: 'Continue' }).check();
  await nextClick(page);
});
