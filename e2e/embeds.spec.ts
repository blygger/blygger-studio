import { test, expect, type Page } from './fixture.ts';

// Public-page embeds (studio#9): EMBED_SCRIPT in src/embeds.ts. Every request
// to YouTube's hosts is answered locally, and recorded, so the suite needs no
// network and can assert what is fetched before the reader presses play.
const ID = 'dQw4w9WgXcQ';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function login(page: Page) {
  await page.goto('/studio/login'); await page.locator('[name=password]').fill('test-password');
  await page.getByRole('button', { name: 'log in', exact: true }).click();
  await expect(page.locator('#composer-text')).toBeVisible();
}
async function publish(page: Page, md: string, kind = 'fragment'): Promise<string> {
  return page.evaluate(async ({ md, kind }) => {
    const json = { 'content-type': 'application/json' };
    const item = await (await fetch('/api/items', { method: 'POST', headers: json, body: JSON.stringify({ content_md: md, kind }) })).json();
    await fetch(`/api/items/${item.id}/publish`, { method: 'POST', headers: json, body: '{}' });
    return item.id as string;
  }, { md, kind });
}
async function stubYouTube(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route(/^https:\/\/i\.ytimg\.com\//, (r) => { seen.push(r.request().url()); return r.fulfill({ contentType: 'image/png', body: PIXEL }); });
  await page.route(/^https:\/\/(www\.)?youtube(-nocookie)?\.com\//, (r) => { seen.push(r.request().url()); return r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>player</title>' }); });
  return seen;
}

test('a bare YouTube link becomes a poster that plays from youtube-nocookie on click', async ({ page }) => {
  const seen = await stubYouTube(page);
  await login(page);
  const href = `https://www.youtube.com/watch?v=${ID}&t=42`;
  const id = await publish(page, `Watch this:\n\n${href}\n\nAnd [a titled link](https://youtu.be/${ID}) stays a link.`);
  await page.goto(`/f/${id}/`);

  const fig = page.locator('article figure.yt-facade');
  await expect(fig).toHaveCount(1);
  const play = fig.getByRole('button', { name: `Play video: ${href}` });
  await expect(play).toBeVisible();
  // The box is 16:9 before anything plays.
  const box = (await play.boundingBox())!;
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.05);
  await expect(fig.locator('img')).toHaveAttribute('src', `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  await expect(fig.locator('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
  // The published link survives as the caption, and prose links are untouched.
  await expect(fig.locator('figcaption a')).toHaveAttribute('href', href);
  await expect(page.locator('article p a', { hasText: 'a titled link' })).toHaveAttribute('href', `https://youtu.be/${ID}`);
  // Nothing from YouTube itself before play; only the poster.
  expect(seen.filter((u) => !u.startsWith('https://i.ytimg.com/'))).toEqual([]);

  await play.click();
  const frame = fig.locator('iframe.yt-frame');
  await expect(frame).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&start=42`);
  await expect(frame).toHaveAttribute('title', 'YouTube video player');
  await expect(fig.getByRole('button')).toHaveCount(0);
  const after = (await frame.boundingBox())!;
  expect(Math.abs(after.height - box.height)).toBeLessThan(3);
});

test('the poster is a keyboard control, and works on a thread page', async ({ page }) => {
  await stubYouTube(page);
  await login(page);
  const id = await publish(page, `A thread with a short.\n\nhttps://youtube.com/shorts/${ID}`, 'thread');
  await page.goto(`/t/${id}/`);
  const play = page.locator('article .yt-play');
  await play.focus();
  await expect(play).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('article iframe.yt-frame')).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0`);
});

test('a lookalike host stays a plain link', async ({ page }) => {
  await stubYouTube(page);
  await login(page);
  const id = await publish(page, `https://youtube.com.evil.example/watch?v=${ID}`);
  await page.goto(`/f/${id}/`);
  await expect(page.locator('article p a', { hasText: 'evil.example' })).toBeVisible();
  await expect(page.locator('.yt-facade')).toHaveCount(0);
});

test('an off-origin image that fails becomes a visible link; own and working images stay images', async ({ page }) => {
  await page.route('https://dead.example/**', (r) => r.fulfill({ status: 404, body: 'gone' }));
  // Answered late, so its error fires after the script is listening; the
  // first fails at once, typically before the script runs (the sweep's case).
  await page.route('https://slow.example/**', async (r) => { await new Promise((ok) => setTimeout(ok, 800)); await r.fulfill({ status: 404, body: 'gone' }); });
  await page.route('https://live.example/**', (r) => r.fulfill({ contentType: 'image/png', body: PIXEL }));
  await login(page);
  const id = await publish(page, [
    '![a chart](https://dead.example/chart.png)',
    '![](https://slow.example/late.png)',
    '[![linked figure](https://dead.example/linked.png)](https://elsewhere.example/post)',
    '![works](https://live.example/ok.png)',
    '![own](/missing-own.png)',
  ].join('\n\n'));
  await page.goto(`/f/${id}/`);

  const chart = page.locator('article a.img-fallback', { hasText: 'a chart' });
  await expect(chart).toHaveText('Image: a chart ↗ (dead.example)');
  await expect(chart).toHaveAttribute('href', 'https://dead.example/chart.png');
  await expect(chart).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('article a.img-fallback', { hasText: 'slow.example' })).toHaveText('Image ↗ (slow.example)');
  // Already inside a link: a span, so links never nest; the outer link is kept.
  const inner = page.locator('article a[href="https://elsewhere.example/post"] > span.img-fallback');
  await expect(inner).toHaveText('Image: linked figure ↗ (dead.example)');
  await expect(page.locator('article img[alt=works]')).toBeVisible();
  await expect(page.locator('article img[alt=own]')).toHaveCount(1);
  await expect(page.locator('article .img-fallback')).toHaveCount(3);
});
