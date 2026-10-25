const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const C = require('../../extension/lib/config.js');
require('../../extension/lib/detect.js');
const FL = require('../../extension/lib/fastlane.js');

const settings = C.resolveSettings({});
const store = (id) => C.resolveStore(id, settings);

test('stock JSON: Best Buy button state', () => {
  assert.equal(FL.parseStockJson([{ skuId: '6601524', buttonState: 'SOLD_OUT', displayText: 'Sold Out' }]).state, 'out_of_stock');
  assert.equal(FL.parseStockJson({ buttonStateResponseInfos: [{ skuId: '6601524', buttonState: 'ADD_TO_CART' }] }).state, 'in_stock');
  assert.equal(FL.parseStockJson([{ buttonState: 'COMING_SOON' }]).state, 'out_of_stock');
  assert.equal(FL.parseStockJson([{ buttonState: 'CHECK_STORES' }]).state, 'out_of_stock');
});

test('stock JSON: Target shipping wins over in-store pickup', () => {
  const r = FL.parseStockJson({
    data: { product: { fulfillment: { store_options: [{ order_pickup: { availability_status: 'IN_STOCK' } }], shipping_options: { availability_status: 'OUT_OF_STOCK' } } } },
  });
  assert.equal(r.state, 'out_of_stock');
  assert.match(r.signal, /shipping_options/);
});

test('stock JSON: PlayStation Direct stock level and Walmart item data', () => {
  assert.equal(FL.parseStockJson({ products: [{ code: '1000046529', stock: { stockLevelStatus: 'inStock' } }] }).state, 'in_stock');
  assert.equal(FL.parseStockJson({ products: [{ stock: { stockLevelStatus: 'outOfStock' } }] }).state, 'out_of_stock');
  assert.equal(FL.parseStockJson({ data: { product: { availabilityStatus: 'IN_STOCK', usItemId: '1' } } }).state, 'in_stock');
});

test('stock JSON: nothing recognisable is unknown, and generic "status" values are ignored', () => {
  assert.equal(FL.parseStockJson({ data: { status: 'ACTIVE', name: 'PS5 Pro' } }).state, 'unknown');
  assert.equal(FL.parseStockJson(null).state, 'unknown');
});

function aod(offers) {
  const blocks = offers
    .map(
      (o, i) => `<div id="${i === 0 ? 'aod-pinned-offer' : 'aod-offer'}">
        <div id="aod-offer-heading"><h5>${o.condition}</h5></div>
        <span class="a-price"><span class="a-offscreen">$${o.price}</span></span>
        <div id="aod-offer-soldBy"><span>Sold by</span> <a>${o.seller}</a></div>
      </div>`
    )
    .join('');
  return new JSDOM(`<div id="aod-container">${blocks}</div>`).window.document;
}

test('Amazon offers: in stock only when Amazon itself sells it new under the cap', () => {
  const amz = store('amazon');
  assert.equal(FL.parseAod(aod([{ condition: 'New', price: '1,299.99', seller: 'Console Kings' }]), amz, settings).state, 'out_of_stock');
  const r = FL.parseAod(aod([{ condition: 'New', price: '1,299.99', seller: 'Console Kings' }, { condition: 'New', price: '899.99', seller: 'Amazon.com' }]), amz, settings);
  assert.deepEqual([r.state, r.price], ['in_stock', 899.99]);
  assert.equal(FL.parseAod(aod([{ condition: 'Used - Like New', price: '749.99', seller: 'Amazon.com' }]), amz, settings).state, 'out_of_stock');
  assert.equal(FL.parseAod(aod([{ condition: 'New', price: '899.99', seller: 'Amazon Resale' }]), amz, settings).state, 'out_of_stock');
  assert.equal(FL.parseAod(new JSDOM('<p>Something went wrong</p>').window.document, amz, settings).state, 'unknown');
});

test('lanes: store stock request URLs built from the product link', () => {
  assert.equal(FL.templateUrl(store('bestbuy'), 'https://www.bestbuy.com/site/6601524.p?skuId=6601524'), 'https://www.bestbuy.com/button-state/api/v5/button-state?skus=6601524&context=pdp&source=buttonView');
  assert.equal(FL.productId(store('bestbuy'), 'https://www.bestbuy.com/product/playstation-5-pro-console/JXHQ37TR86/sku/6601524'), '6601524');
  assert.match(FL.templateUrl(store('amazon'), 'https://www.amazon.com/PlayStation-Pro/dp/B0DGY63Z2H?th=1'), /aodAjaxMain\/\?asin=B0DGY63Z2H/);
  assert.equal(FL.templateUrl(store('target'), 'https://www.target.com/p/x/-/A-93620188'), null);
});

test('lanes: only learn stock requests for this product', () => {
  const t = store('target');
  const page = 'https://www.target.com/p/playstation-5-pro-console/-/A-93620188';
  assert.ok(FL.isLearnable(t, page, 'https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1?key=abc&tcin=93620188&store_id=1'));
  assert.ok(!FL.isLearnable(t, page, 'https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1?key=abc&tcin=11112222'), 'a recommended product');
  assert.ok(!FL.isLearnable(t, page, 'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?tcin=93620188'), 'not a stock request');
});

test('hot windows: parsing', () => {
  assert.deepEqual(FL.parseWindows('Mon-Fri 07:00-12:00'), [{ days: [1, 2, 3, 4, 5], start: 420, end: 720 }]);
  assert.deepEqual(FL.parseWindows('Thu,Fri 06:30-10:00; Sat 09:00-11:00').map((w) => w.days), [[4, 5], [6]]);
  assert.deepEqual(FL.parseWindows('Fri-Mon 20:00-23:00')[0].days, [0, 1, 5, 6]);
  assert.deepEqual(FL.parseWindows('nonsense'), []);
});

test('hot windows: evaluated in Eastern time', () => {
  const w = FL.parseWindows('Mon-Fri 07:00-12:00');
  // Wed 28 Oct 2026, 15:00 UTC = 11:00 EDT
  assert.equal(FL.inWindows(new Date('2026-10-28T15:00:00Z'), w), true);
  // Same day 17:00 UTC = 13:00 EDT
  assert.equal(FL.inWindows(new Date('2026-10-28T17:00:00Z'), w), false);
  // Saturday morning
  assert.equal(FL.inWindows(new Date('2026-10-31T14:00:00Z'), w), false);
  // After the clocks change: Mon 2 Nov 2026, 12:30 UTC = 07:30 EST
  assert.equal(FL.inWindows(new Date('2026-11-02T12:30:00Z'), w), true);
});

test('outside alerts: picks out the store, ignores other products', () => {
  assert.deepEqual(FL.parseTrigger('🚨 PS5 Pro in stock at Best Buy! $899.99'), { matched: true, stores: ['bestbuy'], links: [] });
  assert.deepEqual(FL.parseTrigger('PlayStation 5 Pro Console restock: Target and Walmart').stores, ['target', 'walmart']);
  assert.deepEqual(FL.parseTrigger('PlayStation®5 Pro live on PlayStation Direct').stores, ['psdirect']);
  assert.deepEqual(FL.parseTrigger('PS5 Pro restock!'), { matched: true, stores: [], links: [] });
  assert.equal(FL.parseTrigger('PS5 Slim in stock at Target').matched, false);
  assert.equal(FL.parseTrigger('Xbox at GameStop', { anyProduct: true }).matched, true);
});

test('several listings per store', () => {
  const s = C.resolveSettings({ stores: { bestbuy: { enabled: true, productUrl: 'https://www.bestbuy.com/site/1.p?skuId=1  https://www.bestbuy.com/site/2.p?skuId=2' } } });
  assert.deepEqual(C.watchUrls('bestbuy', s), ['https://www.bestbuy.com/site/1.p?skuId=1', 'https://www.bestbuy.com/site/2.p?skuId=2']);
  assert.equal(C.resolveStore('bestbuy', s).productUrl, 'https://www.bestbuy.com/site/1.p?skuId=1');
  assert.deepEqual(C.watchUrls('target', s), [C.STORES.target.productUrl], 'blank falls back to the built-in link');
  assert.deepEqual(C.watchUrls('amazon', s), [], 'no built-in Amazon link');
});

test('alerts: product links pick the store and are opened; other links are ignored', () => {
  const t = FL.parseTrigger('PS5 Pro restock', {}, [
    'https://www.bestbuy.com/site/6609999.p?skuId=6609999',
    'https://www.bestbuy.com/', // a homepage, not a listing
    'https://howl.me/abc123', // a shortened link we can't tell anything about
  ]);
  assert.deepEqual(t.stores, ['bestbuy']);
  assert.deepEqual(t.links, [{ storeId: 'bestbuy', url: 'https://www.bestbuy.com/site/6609999.p?skuId=6609999' }]);
  assert.equal(FL.parseTrigger('Xbox restock', {}, ['https://www.bestbuy.com/site/1.p?skuId=1']).matched, false);
});
