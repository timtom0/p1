import { expect, test } from '../editor/helpers';

/**
 * PROBE: does an image with no layout box load at all?
 *
 * Asked because the image suite's zero-size test found a real image reporting
 * `naturalWidth: 0`, `complete: true` in a `0x0` box — indistinguishable from a failure. If
 * Chromium skips loading a zero-sized image, then that state is *correct* rather than
 * broken, and the test needs to say so instead of asserting a decode that never happens.
 */
test('PROBE AD: zero-layout-box images and loading', async ({ page }) => {
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 40, 20);
    return canvas.toDataURL('image/png');
  });

  const info = await page.evaluate(async (src) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;width:600px;height:400px';
    document.body.append(host);

    const make = (w: number, h: number): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = `position:absolute;left:10px;top:10px;width:${w}px;height:${h}px`;
        const img = document.createElement('img');
        img.style.cssText = 'display:block;width:100%;height:100%';
        wrap.append(img);
        host.append(wrap);
        img.addEventListener('load', () =>
          resolve({
            box: [w, h],
            loaded: true,
            natural: [img.naturalWidth, img.naturalHeight],
            offset: [img.offsetWidth, img.offsetHeight],
          }),
        );
        img.addEventListener('error', () =>
          resolve({ box: [w, h], loaded: false, natural: [img.naturalWidth, img.naturalHeight] }),
        );
        img.src = src;
        // If neither event ever fires, the image simply was not fetched.
        setTimeout(() => {
          if (img.complete) {
            resolve({
              box: [w, h],
              loaded: 'complete-without-event',
              natural: [img.naturalWidth, img.naturalHeight],
              offset: [img.offsetWidth, img.offsetHeight],
            });
          } else {
            resolve({ box: [w, h], loaded: 'no-event-at-all', natural: [img.naturalWidth, img.naturalHeight] });
          }
        }, 1500);
      });

    const results = [];
    for (const [w, h] of [
      [200, 100],
      [40, 20],
      [0, 0],
      [1, 1],
    ] as const) {
      results.push(await make(w, h));
    }

    // And the same image, detached from layout entirely.
    const detached = new Image();
    detached.src = src;
    let detachedResult: unknown = 'pending';
    await detached.decode().then(
      () => {
        detachedResult = [detached.naturalWidth, detached.naturalHeight];
      },
      (error: Error) => {
        detachedResult = `rejected ${error.name}`;
      },
    );

    host.remove();
    return { results, detachedResult };
  }, png);

  console.log(`PROBE AD: ${JSON.stringify(info, null, 2)}`);

  expect(true).toBe(true);
});
