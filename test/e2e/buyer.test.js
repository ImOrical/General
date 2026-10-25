// End-to-end: the real extension in Chromium against the fake stores in
// mockstores.js. Needs Playwright with Chromium and permission to listen on 443.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { createServer, freshStoreState } = require('./mockstores.js');

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
    fetchIntervalSec: 1,
    reloadIntervalSec: 6,
    jitterPct: 0,
    alerts: { ntfyServer: 'https://ntfy.sh', ntfyTopic: 'e2e-topic', desktop: false, siren: false },
    stores,
    ...extra,
  };
}

async function launch(settings) {
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
  const started = await sw.evaluate(async (s) => {
    await ready;
    await chrome.storage.local.set({ settings: s });
    settings = PS5Config.resolveSettings(s);
    return start();
  }, settings);
  assert.deepEqual(started, { ok: true });
  const state = () => sw.evaluate(() => ({ rt, purchased, log }));
  return { ctx, sw, state, close: () => ctx.close().finally(() => fs.rmSync(dir, { recursive: true, force: true })) };
}

function reset() {
  for (const id of Object.keys(mock.state.stores)) mock.state.stores[id] = freshStoreState();
  mock.state.orders.length = 0;
  mock.state.ntfy.length = 0;
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
      return ['bestbuy', 'target'].every((id) => status[id] && status[id].state === 'out_of_stock' && status[id].source === 'fetch');
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

test('CVV: fills it from settings when the store asks', async () => {
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
