// End-to-end: the real extension in Chromium against the fake stores in
// mockstores.js. Needs Playwright with Chromium and permission to listen on 443.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { createServer, freshStoreState } = require('./mockstores.js');
const V = require('../../extension/lib/vault.js');

const EXT = path.resolve(__dirname, '../../extension');
const TMP = path.join(__dirname, '.tmp');

let mock;

function certs() {
  fs.mkdirSync(TMP, { recursive: true });
  const key = path.join(TMP, 'key.pem');
  const cert = path.join(TMP, 'cert.pem');
  if (!fs.existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=mockstores'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

async function waitFor(fn, { timeout = 30000, every = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error('Timed out waiting for ' + what);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settingsFor(mode, enabled, extra = {}) {
  const stores = {};
  for (const id of ['psdirect', 'bestbuy', 'target', 'walmart', 'amazon', 'gamestop']) stores[id] = { enabled: enabled.includes(id), productUrl: '' };
  return {
    mode,
    detection: 'both',
    apiIntervalSec: 1,
    fetchIntervalSec: 1,
    reloadIntervalSec: 6,
    jitterPct: 0,
    hotWindows: '',
    alerts: { ntfyServer: 'https://ntfy.sh', ntfyTopic: 'e2e-topic', desktop: false, siren: false },
    stores,
    ...extra,
  };
}

const VAULT = { cvv: '123', logins: { bestbuy: { email: 'me@example.com', password: 'hunter2!' }, target: { email: 'me@example.com', password: 'hunter2!' } } };

// vault: 'open' (unlocked with VAULT), 'locked' (saved but not unlocked) or null.
async function launch(settings, { vault = 'open', start: doStart = true } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'profile-'));
  const rules = mock.hosts.map((h) => `MAP ${h} 127.0.0.1`).concat('MAP * ~NOTFOUND').join(', ');
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=${rules}`, '--ignore-certificate-errors', '--no-proxy-server'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const sealed = vault ? await V.seal(VAULT, 'test passphrase') : null;
  const started = await sw.evaluate(
    async ({ s, vault, sealed, data, doStart }) => {
      await ready;
      await chrome.storage.local.set({ settings: s });
      settings = PS5Config.resolveSettings(s);
      if (sealed) await chrome.storage.local.set({ vault: sealed });
      if (vault === 'open') await chrome.storage.session.set({ vaultOpen: data });
      return doStart ? start() : { ok: true };
    },
    { s: settings, vault, sealed, data: VAULT, doStart }
  );
  assert.deepEqual(started, { ok: true });
  const state = () => sw.evaluate(() => ({ rt, purchased, log }));
  return { ctx, sw, state, close: () => ctx.close().finally(() => fs.rmSync(dir, { recursive: true, force: true })) };
}

function reset() {
  for (const id of Object.keys(mock.state.stores)) mock.state.stores[id] = freshStoreState();
  mock.state.orders.length = 0;
  mock.state.ntfy.length = 0;
  mock.state.discord.length = 0;
}

const ntfyTitles = () => mock.state.ntfy.map((n) => n.title);
const logText = (s) => s.log.map((e) => `${e.kind}: ${e.text}`).join('\n');

test.before(async () => {
  mock = await createServer(certs());
});
test.after(() => mock.server.close());
test.beforeEach(reset);

test('armed: sees the restock within seconds and places exactly one order', async () => {
  const b = await launch(settingsFor('armed', ['bestbuy', 'target']));
  try {
    // Drop once both are in steady-state watching (quick checks running).
    await waitFor(async () => {
      const { status } = (await b.state()).rt;
      return ['bestbuy', 'target'].every((id) => status[id] && status[id].state === 'out_of_stock' && status[id].source !== 'live');
    }, { what: 'both stores reported sold out' });

    const dropAt = Date.now();
    mock.state.stores.bestbuy.inStock = true;
    await waitFor(() => mock.state.orders.length === 1, { what: 'an order' });
    const took = Date.now() - dropAt;

    assert.deepEqual(mock.state.orders[0], { store: 'bestbuy', items: 1, subtotal: 899.99, cvv: null });
    assert.ok(took < 15000, `restock to order took ${took}ms`);
    const s = await waitFor(async () => {
      const st = await b.state();
      return st.purchased && st;
    }, { what: 'the confirmation page to be recognised' });
    assert.equal(s.purchased.storeId, 'bestbuy');
    assert.equal(s.rt.running, false, 'stops watching after buying');
    assert.ok(ntfyTitles().some((t) => /IN STOCK at Best Buy/.test(t)), 'in-stock push sent');
    assert.ok(ntfyTitles().some((t) => /ORDER PLACED at Best Buy/.test(t)), 'order push sent');
    console.log(`    restock -> order placed in ${(took / 1000).toFixed(1)}s`);
    if (process.env.E2E_TIMING) for (const e of s.log) if (e.at >= dropAt - 2000) console.log(`    +${((e.at - dropAt) / 1000).toFixed(2)}s ${e.kind}: ${e.text}`);
  } finally {
    await b.close();
  }
});

test('armed: two stores drop at the same moment, only one order is placed', async () => {
  const b = await launch(settingsFor('armed', ['bestbuy', 'target']));
  try {
    await waitFor(async () => Object.keys((await b.state()).rt.status).length === 2, { what: 'first reports' });
    mock.state.stores.bestbuy.inStock = true;
    mock.state.stores.target.inStock = true;
    await waitFor(() => mock.state.orders.length >= 1, { what: 'an order' });
    await sleep(10000);
    assert.equal(mock.state.orders.length, 1, 'exactly one order: ' + JSON.stringify(mock.state.orders));
  } finally {
    await b.close();
  }
});

test('scalper listing (third-party seller, $1,299) is ignored: no cart, no in-stock alert', async () => {
  Object.assign(mock.state.stores.walmart, { inStock: true, price: 1299.99, seller: 'ScalpCo Gaming' });
  const b = await launch(settingsFor('armed', ['walmart']));
  try {
    await waitFor(async () => {
      const st = (await b.state()).rt.status.walmart;
      return st && st.state === 'in_stock' && st.source === 'live';
    }, { what: 'walmart live report' });
    await sleep(4000);
    assert.equal(mock.state.stores.walmart.adds, 0);
    assert.equal(mock.state.orders.length, 0);
    assert.ok(!ntfyTitles().some((t) => /IN STOCK/.test(t)));
  } finally {
    await b.close();
  }
});

test('monitor mode alerts but never touches the cart', async () => {
  mock.state.stores.walmart.inStock = true;
  const b = await launch(settingsFor('monitor', ['walmart']));
  try {
    await waitFor(() => ntfyTitles().some((t) => /IN STOCK at Walmart/.test(t)), { what: 'in-stock push' });
    await sleep(3000);
    assert.equal(mock.state.stores.walmart.adds, 0);
  } finally {
    await b.close();
  }
});

test('dry run goes to Place Order, stops, and tells you', async () => {
  const b = await launch(settingsFor('dryrun', ['target']));
  try {
    await sleep(2500);
    mock.state.stores.target.inStock = true;
    await waitFor(() => ntfyTitles().some((t) => /Dry run reached Place Order at Target/.test(t)), { what: 'dry-run push' });
    assert.equal(mock.state.stores.target.adds, 1, 'added to cart once');
    assert.equal(mock.state.orders.length, 0, 'did not order');
  } finally {
    await b.close();
  }
});

test('Best Buy "Please Wait" queue button: waits its turn, then buys', async () => {
  Object.assign(mock.state.stores.bestbuy, { inStock: true, pleaseWaitMs: 5000 });
  const b = await launch(settingsFor('armed', ['bestbuy']));
  try {
    await waitFor(() => mock.state.orders.length === 1, { timeout: 40000, what: 'an order after the wait' });
    assert.equal(mock.state.stores.bestbuy.waited, true);
  } finally {
    await b.close();
  }
});

test('CVV: fills it in when the store asks', async () => {
  Object.assign(mock.state.stores.bestbuy, { inStock: true, requireCvv: true });
  const b = await launch(settingsFor('armed', ['bestbuy'], { cvv: '123' }));
  try {
    await waitFor(() => mock.state.orders.length === 1, { what: 'an order' });
    assert.equal(mock.state.orders[0].cvv, '123');
  } finally {
    await b.close();
  }
});

test('CAPTCHA at checkout: stops and asks you, never orders', async () => {
  Object.assign(mock.state.stores.target, { inStock: true, captchaAtCheckout: true });
  const b = await launch(settingsFor('armed', ['target']));
  try {
    await waitFor(() => ntfyTitles().some((t) => /Target: needs you/.test(t)), { what: 'needs-you push' });
    assert.ok(mock.state.ntfy.some((n) => /CAPTCHA/.test(n.body)));
    assert.equal(mock.state.orders.length, 0);
  } finally {
    await b.close();
  }
});

test('extra items in the cart: refuses to place the order', async () => {
  const st = mock.state.stores.walmart;
  Object.assign(st, { inStock: true });
  st.cart.push({ name: 'HDMI Cable', price: 19.99 });
  const b = await launch(settingsFor('armed', ['walmart']));
  try {
    await waitFor(() => mock.state.ntfy.some((n) => /Stopped before Place Order/.test(n.body)), { what: 'guard push' });
    assert.equal(mock.state.orders.length, 0);
    const s = await b.state();
    assert.match(logText(s), /over your \$899.99 cap/);
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------- sign-in, CVV, keeper

test('signed out at checkout: signs in from the vault (ticking "keep me signed in") and still buys', async () => {
  Object.assign(mock.state.stores.bestbuy, { inStock: true, requireLogin: true });
  const b = await launch(settingsFor('armed', ['bestbuy']));
  try {
    await waitFor(() => mock.state.orders.length === 1, { timeout: 40000, what: 'an order after signing in' });
    assert.deepEqual(mock.state.stores.bestbuy.logins, [{ email: 'me@example.com', remember: true }]);
  } finally {
    await b.close();
  }
});

test('email-first sign-in (Target style) and a CVV box inside an iframe', async () => {
  Object.assign(mock.state.stores.target, { inStock: true, requireLogin: true, requireCvv: true, cvvInFrame: true });
  const b = await launch(settingsFor('armed', ['target']));
  try {
    await waitFor(() => mock.state.orders.length === 1, { timeout: 40000, what: 'an order' });
    assert.equal(mock.state.orders[0].cvv, '123');
    assert.equal(mock.state.stores.target.logins.length, 1);
  } finally {
    await b.close();
  }
});

test('one-time code after the password: alerts you, never orders', async () => {
  Object.assign(mock.state.stores.bestbuy, { inStock: true, requireLogin: true, otp: true });
  const b = await launch(settingsFor('armed', ['bestbuy']));
  try {
    await waitFor(() => mock.state.ntfy.some((n) => /verification code/.test(n.body)), { timeout: 40000, what: 'code push' });
    assert.equal(mock.state.orders.length, 0);
  } finally {
    await b.close();
  }
});

test('vault locked: tells you to unlock it instead of failing silently', async () => {
  Object.assign(mock.state.stores.bestbuy, { inStock: true, requireLogin: true });
  const b = await launch(settingsFor('armed', ['bestbuy']), { vault: 'locked' });
  try {
    await waitFor(() => mock.state.ntfy.some((n) => /vault is locked/.test(n.body)), { timeout: 40000, what: 'vault-locked push' });
    assert.ok(mock.state.ntfy.some((n) => /LOCKED/.test(n.body)), 'the start message warned about the locked vault');
    assert.equal(mock.state.orders.length, 0);
  } finally {
    await b.close();
  }
});

test('session keeper: notices you were signed out and signs back in ahead of a drop', async () => {
  Object.assign(mock.state.stores.bestbuy, { requireLogin: true });
  Object.assign(mock.state.stores.target, { requireLogin: true });
  const b = await launch(settingsFor('monitor', ['bestbuy', 'target']), { start: false });
  try {
    await b.sw.evaluate(() => runKeeper());
    let s = await b.state();
    assert.equal(s.rt.signin.bestbuy.state, 'auto', JSON.stringify(s.rt.signin));
    assert.equal(s.rt.signin.target.state, 'auto', JSON.stringify(s.rt.signin));
    await b.sw.evaluate(() => runKeeper());
    s = await b.state();
    assert.equal(s.rt.signin.bestbuy.state, 'ok', 'second check finds the session still good');
    assert.equal(mock.state.stores.bestbuy.logins.length, 1, 'did not sign in twice');
    const keeperTabs = await b.sw.evaluate(async () => (await chrome.tabs.query({})).filter((t) => /myaccount|\/account/.test(t.url)).length);
    assert.equal(keeperTabs, 0, 'check tabs were closed');
  } finally {
    await b.close();
  }
});

test('dashboard vault: save encrypted, lock, wrong passphrase, unlock', async () => {
  const b = await launch(settingsFor('monitor', ['bestbuy']), { vault: null, start: false });
  try {
    const id = new URL(b.sw.url()).host;
    const page = await b.ctx.newPage();
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    await page.fill('#vaultLogins input[data-store="bestbuy"][data-field="email"]', 'me@example.com');
    await page.fill('#vaultLogins input[data-store="bestbuy"][data-field="password"]', 'hunter2!');
    await page.fill('#vaultCvv', '123');
    await page.fill('#vaultPass', 'my passphrase');
    await page.click('#vaultSave');
    await page.waitForFunction(() => /Saved 1 login/.test(document.getElementById('vaultMsg').textContent));
    const stored = await b.sw.evaluate(async () => ({ local: (await chrome.storage.local.get('vault')).vault, open: (await chrome.storage.session.get('vaultOpen')).vaultOpen }));
    assert.ok(stored.local.ct && !JSON.stringify(stored.local).includes('hunter2'), 'saved encrypted');
    assert.equal(stored.open.logins.bestbuy.password, 'hunter2!');

    await page.click('#vaultLock');
    await page.waitForFunction(() => document.getElementById('vaultStatus').textContent === 'Locked');
    assert.equal(await b.sw.evaluate(async () => (await chrome.storage.session.get('vaultOpen')).vaultOpen || null), null);

    await page.fill('#vaultPass', 'nope nope');
    await page.click('#vaultUnlock');
    await page.waitForFunction(() => /Wrong passphrase/.test(document.getElementById('vaultMsg').textContent));

    await page.fill('#vaultPass', 'my passphrase');
    await page.click('#vaultUnlock');
    await page.waitForFunction(() => document.getElementById('vaultStatus').textContent === 'Unlocked');
    assert.equal(await page.inputValue('#vaultLogins input[data-store="bestbuy"][data-field="email"]'), 'me@example.com');
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------- speed

const status = (b, key) => b.state().then((s) => s.rt.status[key]);

test("Best Buy's stock lookup catches the restock without waiting for a page reload", async () => {
  const b = await launch(settingsFor('monitor', ['bestbuy'], { reloadIntervalSec: 120 }));
  try {
    await waitFor(async () => {
      const st = await status(b, 'bestbuy');
      return st && st.lane === 'template' && st.state === 'out_of_stock';
    }, { what: 'the stock lookup lane' });
    const hitsBefore = mock.state.stores.bestbuy.apiHits;
    const dropAt = Date.now();
    mock.state.stores.bestbuy.inStock = true;
    await waitFor(() => mock.state.ntfy.some((n) => /IN STOCK at Best Buy/.test(n.title)), { timeout: 15000, what: 'in-stock push' });
    const took = Date.now() - dropAt;
    assert.ok(mock.state.stores.bestbuy.apiHits > hitsBefore, 'used the stock lookup');
    assert.ok(took < 5000, `took ${took}ms`);
    const s = await b.state();
    assert.ok(s.log.some((e) => /Hot mode/.test(e.text)), 'went hot');
    console.log(`    stock lookup: restock -> alert in ${(took / 1000).toFixed(1)}s`);
  } finally {
    await b.close();
  }
});

test("Target: learns the page's own stock request, and pickup-only stock doesn't count", async () => {
  Object.assign(mock.state.stores.target, { pickupInStock: true });
  const b = await launch(settingsFor('monitor', ['target'], { reloadIntervalSec: 120 }));
  try {
    await waitFor(async () => {
      const st = await status(b, 'target');
      return st && st.lane === 'learned' && st.source === 'api';
    }, { what: 'the learned lane' });
    assert.equal((await status(b, 'target')).state, 'out_of_stock', 'pickup-only is not in stock for shipping');
    await sleep(2500);
    assert.ok(!ntfyTitles().some((t) => /IN STOCK/.test(t)), 'no alert for pickup-only or the recommended product');
    mock.state.stores.target.inStock = true;
    await waitFor(() => ntfyTitles().some((t) => /IN STOCK at Target/.test(t)), { timeout: 15000, what: 'in-stock push' });
  } finally {
    await b.close();
  }
});

test('outside alert (e.g. forwarded HotStock) makes it check that store immediately and buy', async () => {
  const b = await launch(
    settingsFor('armed', ['bestbuy', 'target'], { apiIntervalSec: 0, fetchIntervalSec: 0, reloadIntervalSec: 300, trigger: { ntfyTopic: 'e2e-trigger', anyProduct: false } })
  );
  try {
    await waitFor(async () => (await b.state()).rt.triggerConnected, { what: 'listening on the trigger topic' });
    await sleep(2000); // let the first page loads finish
    mock.state.stores.bestbuy.inStock = true;
    mock.state.publish('e2e-trigger', 'PS5 Slim in stock at Best Buy');
    await sleep(2500);
    assert.equal(mock.state.orders.length, 0, 'an alert about another product is ignored');
    const sent = Date.now();
    mock.state.publish('e2e-trigger', '🚨 PS5 Pro in stock at Best Buy!');
    await waitFor(() => mock.state.orders.length === 1, { timeout: 20000, what: 'an order' });
    const took = Date.now() - sent;
    assert.equal(mock.state.orders[0].store, 'bestbuy');
    const s = await b.state();
    assert.ok(s.log.some((e) => e.kind === 'trigger' && /checking Best Buy now/.test(e.text)));
    console.log(`    outside alert -> order placed in ${(took / 1000).toFixed(1)}s (with normal checks every 5 minutes)`);
  } finally {
    await b.close();
  }
});

test('two listings at one store: watches both and buys the one that restocks', async () => {
  const both = 'https://www.bestbuy.com/site/6601524.p?skuId=6601524 https://www.bestbuy.com/site/6609999.p?skuId=6609999';
  const cfg = settingsFor('armed', ['bestbuy']);
  cfg.stores.bestbuy.productUrl = both;
  const b = await launch(cfg);
  try {
    await waitFor(async () => {
      const s = await b.state();
      return s.rt.status.bestbuy && s.rt.status['bestbuy#2'];
    }, { what: 'both listings reporting' });
    mock.state.stores.bestbuy.altInStock = true;
    await waitFor(() => mock.state.orders.length === 1, { what: 'an order' });
    assert.equal((await status(b, 'bestbuy#2')).state, 'in_stock');
  } finally {
    await b.close();
  }
});

test('store refuses quick checks: not shown as blocked, no phone alert, still catches the restock by reloading', async () => {
  Object.assign(mock.state.stores.bestbuy, { refuseQuick: true });
  const b = await launch(settingsFor('monitor', ['bestbuy'], { reloadIntervalSec: 120, reloadOnlySec: 4 }));
  try {
    await waitFor(async () => {
      const s = await b.state();
      return s.rt.speed.bestbuy && s.rt.speed.bestbuy.quickOff;
    }, { timeout: 30000, what: 'switching to reloads only' });
    const st = await status(b, 'bestbuy');
    assert.equal(st.state, 'out_of_stock', 'still shows the real stock state, not "blocked"');
    assert.ok(!mock.state.ntfy.some((n) => /block|bot check/i.test(n.title + n.body)), 'no phone alert for refused quick checks');
    mock.state.stores.bestbuy.inStock = true;
    await waitFor(() => ntfyTitles().some((t) => /IN STOCK at Best Buy/.test(t)), { timeout: 20000, what: 'in-stock push via reloads' });
    assert.ok(mock.state.stores.bestbuy.refused >= 3);
  } finally {
    await b.close();
  }
});

test('checkout shortcut: skips the cart, and falls back when a store insists on it', async () => {
  mock.state.stores.bestbuy.inStock = true;
  mock.state.stores.walmart.inStock = true;
  const b = await launch(settingsFor('armed', ['walmart']));
  try {
    await waitFor(() => mock.state.orders.length === 1, { what: 'Walmart order via the cart' });
    const s = await b.state();
    assert.match(logText(s), /straight to checkout/);
    assert.equal(mock.state.stores.walmart.cartViewed, true, 'Walmart bounced it to the cart, which still worked');
  } finally {
    await b.close();
  }
  mock.state.orders.length = 0;
  const b2 = await launch(settingsFor('armed', ['bestbuy']));
  try {
    await waitFor(() => mock.state.orders.length === 1, { what: 'Best Buy order' });
    assert.equal(mock.state.stores.bestbuy.cartViewed, false, 'Best Buy went straight to checkout, no cart page');
  } finally {
    await b2.close();
  }
});

// ---------------------------------------------------------------- Discord / alerts mode

const alertsCfg = (mode, stores) =>
  settingsFor(mode, stores, { detection: 'alerts', safetyReloadSec: 300, burstReloadSec: 3, burstMinutes: 1, discord: { channels: 'https://discord.com/channels/1/2', openLinks: true } });

async function discordReady(b) {
  await waitFor(async () => {
    const d = Object.values((await b.state()).rt.discord || {});
    return d.length && d.every((c) => c.signedIn);
  }, { what: 'the Discord channel to open' });
  await sleep(1500);
}

test('alerts mode: a Discord restock post makes it check that store and buy, with no polling in between', async () => {
  const b = await launch(alertsCfg('armed', ['bestbuy', 'target']));
  try {
    await discordReady(b);
    const hits = { bestbuy: mock.state.stores.bestbuy.pdpHits, target: mock.state.stores.target.pdpHits };
    await sleep(5000);
    assert.equal(mock.state.stores.bestbuy.pdpHits, hits.bestbuy, 'no checks while waiting for alerts');
    assert.equal(mock.state.stores.target.pdpHits, hits.target, "the hour-old Target post in the channel's history didn't trigger anything");
    mock.state.stores.bestbuy.inStock = true;
    const posted = Date.now();
    mock.state.discordPost('PlayStation 5 Pro Console - 2TB', 'Retailer: Best Buy · Price: $899.99');
    await waitFor(() => mock.state.orders.length === 1, { timeout: 20000, what: 'an order' });
    assert.equal(mock.state.orders[0].store, 'bestbuy');
    assert.equal(mock.state.stores.target.pdpHits, hits.target, 'a Best Buy post only checks Best Buy');
    console.log(`    Discord post -> order placed in ${((Date.now() - posted) / 1000).toFixed(1)}s`);
  } finally {
    await b.close();
  }
});

test('alerts mode: a post linking a different listing opens it and buys it', async () => {
  mock.state.stores.bestbuy.altInStock = true;
  const b = await launch(alertsCfg('armed', ['bestbuy']));
  try {
    await discordReady(b);
    mock.state.discordPost('PS5 Pro restock', 'Best Buy (new SKU)', 'https://www.bestbuy.com/site/6609999.p?skuId=6609999');
    await waitFor(() => mock.state.orders.length === 1, { timeout: 20000, what: 'an order from the linked listing' });
    const s = await b.state();
    assert.match(logText(s), /opened the linked Best Buy listing/);
  } finally {
    await b.close();
  }
});

test('alerts mode: posts about other products are ignored', async () => {
  const b = await launch(alertsCfg('armed', ['bestbuy']));
  try {
    await discordReady(b);
    mock.state.stores.bestbuy.inStock = true;
    const hits = mock.state.stores.bestbuy.pdpHits;
    mock.state.discordPost('Xbox Series X restock', 'Retailer: Best Buy', 'https://www.bestbuy.com/site/6512345.p?skuId=6512345');
    mock.state.discordPost('PS5 Slim Digital', 'Retailer: Best Buy');
    await sleep(4000);
    assert.equal(mock.state.stores.bestbuy.pdpHits, hits);
    assert.equal(mock.state.orders.length, 0);
  } finally {
    await b.close();
  }
});
