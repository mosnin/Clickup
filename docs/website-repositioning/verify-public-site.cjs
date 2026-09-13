/* Usage: WEBSITE_TEST_PACKAGE_JSON=/path/to/package.json node docs/website-repositioning/verify-public-site.cjs http://localhost:3110
   The selected test runtime must provide playwright-core and a local Chrome installation. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const runtime = createRequire(path.resolve(process.env.WEBSITE_TEST_PACKAGE_JSON || 'package.json'));
const { chromium } = runtime('playwright-core');
const origin = process.argv[2];
if (!origin) throw new Error('Pass the local production preview URL.');
const source = fs.existsSync('web/src/lib/website/stories.json') ? 'web/src' : 'src';
const stories = JSON.parse(fs.readFileSync(source + '/lib/website/stories.json'));
const output = path.join(__dirname, 'evidence');
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const routes = [];
    for (const route of ['/', '/pricing', '/demo', '/resources', ...Object.keys(stories).map(s => '/' + s)]) {
      const response = await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700);
      routes.push({ route, status: response.status(), ...await page.evaluate(() => ({
        h1: Array.from(document.querySelectorAll('h1'), n => n.textContent),
        overflow: document.documentElement.scrollWidth > innerWidth,
        description: document.querySelector('meta[name="description"]')?.content,
        canonical: document.querySelector('link[rel="canonical"]')?.href,
      })) });
    }
    const controls = [];
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + '/pricing');
      await page.waitForTimeout(1500);
      controls.push({ width, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
      await page.screenshot({ path: output + '/pricing-' + width + '.png', fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: output + '/home-desktop.png' });
    for (const menu of ['Product', 'Solutions', 'Resources', 'Company']) {
      const button = page.getByRole('button', { name: menu, exact: true }).filter({ visible: true }).first();
      await button.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      const expanded = await button.getAttribute('aria-expanded');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      controls.push({ menu, expanded, closed: await button.getAttribute('aria-expanded'), focus: await button.evaluate(el => el === document.activeElement) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: output + '/home-mobile.png' });
    const trigger = page.getByRole('button', { name: /open menu|toggle menu|^menu$/i }).filter({ visible: true }).first();
    await trigger.click();
    await page.waitForTimeout(500);
    const solutions = await page.getByRole('button', { name: 'Solutions', exact: true }).filter({ visible: true }).count() + await page.getByText('Solutions', { exact: true }).filter({ visible: true }).count();
    await page.screenshot({ path: output + '/menu-mobile.png' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    controls.push({ mobileMenu: true, solutionsVisible: solutions > 0, focusReturned: await trigger.evaluate(el => el === document.activeElement) });
    for (const [file, value] of [['routes', routes], ['controls', controls], ['browser-errors', errors]]) fs.writeFileSync(output + '/' + file + '.json', JSON.stringify(value, null, 2) + '\n');
    const failures = routes.filter(r => r.status !== 200 || r.h1.length !== 1 || r.overflow || !r.description);
    const controlsFailed = controls.filter(c => c.overflow || (c.menu && (c.expanded !== 'true' || c.closed !== 'false' || !c.focus)) || (c.mobileMenu && (!c.solutionsVisible || !c.focusReturned)));
    console.log(JSON.stringify({ routes: routes.length, failures, controlsFailed, browserErrors: errors }));
    if (failures.length || controlsFailed.length || errors.length) process.exitCode = 1;
  } finally { await browser.close(); }
})();
