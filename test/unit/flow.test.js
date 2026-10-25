const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const C = require('../../extension/lib/config.js');
require('../../extension/lib/detect.js');
const F = require('../../extension/lib/flow.js');

const settings = C.resolveSettings({});
const store = (id) => C.resolveStore(id, settings);
const page = (html, url = 'https://www.bestbuy.com/checkout/r/fast-track') => new JSDOM(html, { url }).window.document;
const ctx = { priceCap: 899.99, minPrice: 600, practice: false };

test('subtotal: "Subtotal (1 item)" with the amount in a sibling', () => {
  const doc = page('<div class="summary"><div class="row"><span>Subtotal (1 item)</span><span>$899.99</span></div><div class="row"><span>Estimated tax</span><span>$74.25</span></div></div>');
  assert.equal(F.findSubtotal(doc, store('target')), 899.99);
});

test('subtotal: Amazon-style "Items:" row in a table', () => {
  const doc = page('<table><tr><td>Items:</td><td>$899.99</td></tr><tr><td>Shipping &amp; handling:</td><td>$0.00</td></tr><tr><td>Order total:</td><td>$974.24</td></tr></table>');
  assert.equal(F.findSubtotal(doc, store('amazon')), 899.99);
});

test('subtotal: two consoles in the cart reads the doubled subtotal', () => {
  const doc = page('<ul><li><span>Subtotal</span> <b>$1,799.98</b></li></ul>');
  assert.equal(F.findSubtotal(doc, store('bestbuy')), 1799.98);
});

test('subtotal: store-specific selector wins when configured', () => {
  const s = C.resolveStore('bestbuy', { ...settings, overrides: { bestbuy: { checkout: { subtotalSelectors: ['#exact'] } } } });
  const doc = page('<div><span>Subtotal</span><span>$1.00</span></div><div id="exact">$899.99</div>');
  assert.equal(F.findSubtotal(doc, s), 899.99);
});

test('final guard passes for one PS5 Pro at the cap', () => {
  const doc = page('<div>PlayStation 5 Pro Console</div><div><span>Subtotal</span><span>$899.99</span></div><button>Place Your Order</button>');
  assert.deepEqual(F.finalGuard(doc, store('bestbuy'), ctx), { ok: true, subtotal: 899.99, problems: [] });
});

test('final guard stops when something else is in the cart', () => {
  const doc = page('<div>PlayStation 5 Pro Console</div><div>HDMI Cable</div><div><span>Subtotal</span><span>$919.98</span></div>');
  const g = F.finalGuard(doc, store('bestbuy'), ctx);
  assert.equal(g.ok, false);
  assert.match(g.problems[0], /over your \$899.99 cap/);
});

test('final guard stops when the order is not a PS5 Pro', () => {
  const doc = page('<div>PlayStation 5 Slim Console</div><div><span>Subtotal</span><span>$649.99</span></div>');
  assert.equal(F.finalGuard(doc, store('bestbuy'), ctx).ok, false);
});

test('final guard stops when the subtotal cannot be read', () => {
  const doc = page('<div>PlayStation 5 Pro Console</div><div>Total due today</div>');
  assert.equal(F.finalGuard(doc, store('bestbuy'), ctx).ok, false);
});

test('final guard in practice mode ignores product and price', () => {
  const doc = page('<div>USB-C Cable</div><div><span>Subtotal</span><span>$9.99</span></div>');
  assert.equal(F.finalGuard(doc, store('bestbuy'), { ...ctx, practice: true }).ok, true);
});

test('confirmation by URL and by strong text only', () => {
  const s = store('bestbuy');
  assert.equal(F.isConfirmation(page('<p>Hi</p>'), 'https://www.bestbuy.com/checkout/r/thank-you', s), true);
  assert.equal(F.isConfirmation(page('<h1>Thank you for your order!</h1>'), 'https://www.bestbuy.com/checkout/r/x', s), true);
  assert.equal(F.isConfirmation(page('<p>Your order confirmation will be emailed to you.</p><button>Place Your Order</button>'), 'https://www.bestbuy.com/checkout/r/fast-track', s), false);
});

test('new failure text after clicking Place Order is detected; existing policy text is not', () => {
  const before = 'Review your order. If an item is out of stock we will refund you.';
  assert.equal(F.newFailures(before, before), false);
  assert.equal(F.newFailures(before, before + ' Sorry, this item is no longer available.'), true);
});

test('empty cart is recognised', () => {
  assert.equal(F.isEmptyCart(page('<h1>Your cart is empty</h1>')), true);
  assert.equal(F.isEmptyCart(page('<h1>Your cart</h1><p>PlayStation 5 Pro</p>')), false);
});

test('every store maps product, cart and checkout URLs to the right steps', () => {
  const cases = {
    psdirect: ['https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb', 'https://direct.playstation.com/en-us/cart', 'https://direct.playstation.com/en-us/checkout'],
    bestbuy: ['https://www.bestbuy.com/site/6601524.p?skuId=6601524', 'https://www.bestbuy.com/cart', 'https://www.bestbuy.com/checkout/r/fast-track'],
    target: ['https://www.target.com/p/playstation-5-pro-console/-/A-93620188', 'https://www.target.com/cart', 'https://www.target.com/checkout'],
    walmart: ['https://www.walmart.com/ip/x/18235967161', 'https://www.walmart.com/cart', 'https://www.walmart.com/checkout/review-order'],
    amazon: ['https://www.amazon.com/PlayStation-5-Pro/dp/B0EXAMPLE1', 'https://www.amazon.com/gp/cart/view.html', 'https://www.amazon.com/checkout/p/p-123/spc'],
    gamestop: ['https://www.gamestop.com/consoles-hardware/playstation-5/consoles/products/sony-playstation-5-pro-console/20015604.html', 'https://www.gamestop.com/cart/', 'https://www.gamestop.com/checkout/'],
  };
  for (const [id, [pdp, cart, checkout]] of Object.entries(cases)) {
    const s = store(id);
    assert.equal(F.stepsFor(s, pdp)[0].id, 'pdp', `${id} pdp`);
    assert.equal(F.stepsFor(s, cart)[0].id, 'cart', `${id} cart`);
    assert.equal(F.stepsFor(s, checkout)[0].id, 'place', `${id} checkout`);
    assert.ok(F.stepsFor(s, checkout).some((st) => st.final), `${id} has a final step`);
  }
});

test('sign-in pages ask for the user instead of clicking', () => {
  const steps = F.stepsFor(store('amazon'), 'https://www.amazon.com/ap/signin?openid.return_to=x');
  assert.ok(steps[0].needsUser);
});

test('overrides merge into store definitions and user links win', () => {
  const s = C.resolveStore('bestbuy', {
    ...settings,
    stores: { ...settings.stores, bestbuy: { enabled: true, productUrl: 'https://www.bestbuy.com/site/other.p?skuId=1' } },
    overrides: { bestbuy: { detect: { priceSelectors: ['.new-price'] } } },
  });
  assert.equal(s.productUrl, 'https://www.bestbuy.com/site/other.p?skuId=1');
  assert.deepEqual(s.detect.priceSelectors, ['.new-price']);
  assert.ok(s.detect.buy.selectors.length > 0, 'untouched fields survive');
  assert.ok(C.STORES.bestbuy.detect.priceSelectors.length > 1, 'defaults are not mutated');
});

test('every store regex compiles', () => {
  for (const [id, s] of Object.entries(C.STORES)) {
    const srcs = [s.firstPartySeller, s.detect.buy.text, s.detect.inviteText, s.checkout.confirm.url, s.checkout.confirm.text];
    for (const step of s.checkout.steps) srcs.push(step.url, step.click && step.click.text, step.waitText, step.after && step.after.waitFor);
    for (const src of srcs.filter(Boolean)) assert.doesNotThrow(() => C.re(src), `${id}: ${src}`);
  }
});
