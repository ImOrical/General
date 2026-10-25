const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const C = require('../../extension/lib/config.js');
const D = require('../../extension/lib/detect.js');

const settings = C.resolveSettings({});
const store = (id) => C.resolveStore(id, settings);
const page = (html, url) => new JSDOM(html, { url }).window.document;
const detect = (id, html, url) => D.detect(page(html, url), store(id), url);

const BB_URL = 'https://www.bestbuy.com/site/6601524.p?skuId=6601524';

function bestBuy({ button = '<button class="add-to-cart-button" data-button-state="ADD_TO_CART">Add to Cart</button>', price = '$899.99', seller = '', extra = '' } = {}) {
  return `<html><head><title>PlayStation 5 Pro Console - Best Buy</title></head><body>
    <main>
      <h1>PlayStation 5 Pro Console</h1>
      <div data-testid="customer-price"><span>${price}</span></div>
      ${seller}
      <div class="fulfillment-add-to-cart-button">${button}</div>
    </main>
    ${extra}
  </body></html>`;
}

test('Best Buy: enabled Add to Cart at $899.99 is a buy', () => {
  const r = detect('bestbuy', bestBuy(), BB_URL);
  assert.equal(r.state, 'in_stock');
  assert.equal(r.price, 899.99);
  assert.equal(r.firstParty, true);
  assert.equal(r.productMatch, true);
  assert.deepEqual(D.evaluate(r, settings), { ok: true, alert: true, reasons: [] });
});

test('Best Buy: Sold Out button is out of stock', () => {
  const r = detect('bestbuy', bestBuy({ button: '<button class="add-to-cart-button" data-button-state="SOLD_OUT" disabled>Sold Out</button>' }), BB_URL);
  assert.equal(r.state, 'out_of_stock');
  assert.equal(D.evaluate(r, settings).ok, false);
});

test('Best Buy: an Add to Cart in a recommendations carousel does not count', () => {
  const html = bestBuy({
    button: '<button class="add-to-cart-button" data-button-state="SOLD_OUT" disabled>Sold Out</button>',
    extra: '<section class="carousel"><button>Add to Cart</button></section>',
  });
  assert.equal(detect('bestbuy', html, BB_URL).state, 'out_of_stock');
});

test('Best Buy: marketplace scalper listing is rejected without an alert', () => {
  const r = detect('bestbuy', bestBuy({ price: '$1,299.99', seller: '<div data-testid="marketplace-seller">Sold by GameDealz LLC</div>' }), BB_URL);
  assert.equal(r.state, 'in_stock');
  assert.equal(r.firstParty, false);
  assert.equal(r.price, 1299.99);
  const v = D.evaluate(r, settings);
  assert.equal(v.ok, false);
  assert.equal(v.alert, false);
});

test('over the price cap is rejected even when sold by the store', () => {
  const v = D.evaluate(detect('bestbuy', bestBuy({ price: '$949.99' }), BB_URL), settings);
  assert.equal(v.ok, false);
  assert.match(v.reasons[0], /over your \$899.99 cap/);
});

test('a suspiciously low price alerts but does not auto-buy', () => {
  const v = D.evaluate(detect('bestbuy', bestBuy({ price: '$79.99' }), BB_URL), settings);
  assert.deepEqual([v.ok, v.alert], [false, true]);
});

test('a lower cap (e.g. a Black Friday price) is respected', () => {
  const r = detect('bestbuy', bestBuy({ price: '$899.99' }), BB_URL);
  assert.equal(D.evaluate(r, { ...settings, priceCap: 799.99 }).ok, false);
  assert.equal(D.evaluate(detect('bestbuy', bestBuy({ price: '$799.99' }), BB_URL), { ...settings, priceCap: 799.99 }).ok, true);
});

function walmart(product, button = '') {
  return `<html><head><title>Sony PlayStation 5 Pro Console - Walmart.com</title>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { product } } } } })}</script>
  </head><body><main><h1 id="main-title">Sony PlayStation 5 Pro Console</h1>${button}</main></body></html>`;
}
const WM_URL = 'https://www.walmart.com/ip/Sony-PlayStation-5-Pro-Console-PS5-Pro/18235967161';
const wmProduct = (over = {}) => ({ name: 'Sony PlayStation 5 Pro Console', usItemId: '1', availabilityStatus: 'IN_STOCK', sellerDisplayName: 'Walmart.com', priceInfo: { currentPrice: { price: 899.99 } }, ...over });

test('Walmart: page data says in stock and sold by Walmart.com', () => {
  const r = detect('walmart', walmart(wmProduct()), WM_URL);
  assert.equal(r.state, 'in_stock');
  assert.equal(r.price, 899.99);
  assert.equal(r.firstParty, true);
  assert.equal(D.evaluate(r, settings).ok, true);
});

test('Walmart: third-party seller "fulfilled by Walmart" is not first party', () => {
  const html = walmart(wmProduct({ sellerDisplayName: undefined }), '<div data-testid="product-seller-info">Sold by ProGamerDeals, Fulfilled by Walmart</div>');
  assert.equal(detect('walmart', html, WM_URL).firstParty, false);
});

test('Walmart: no seller info anywhere means unknown, which alerts instead of buying', () => {
  const r = detect('walmart', walmart(wmProduct({ sellerDisplayName: undefined })), WM_URL);
  assert.equal(r.firstParty, null);
  assert.deepEqual([D.evaluate(r, settings).ok, D.evaluate(r, settings).alert], [false, true]);
});

test('Walmart: OUT_OF_STOCK in page data', () => {
  assert.equal(detect('walmart', walmart(wmProduct({ availabilityStatus: 'OUT_OF_STOCK' })), WM_URL).state, 'out_of_stock');
});

test('Walmart: Restored (refurbished) listing is not new', () => {
  const r = detect('walmart', walmart(wmProduct({ name: 'Restored Sony PlayStation 5 Pro Console' })).replace('<h1 id="main-title">Sony', '<h1 id="main-title">Restored Sony'), WM_URL);
  assert.equal(r.notNew, true);
  assert.equal(D.evaluate(r, settings).ok, false);
});

function amazon({ title = 'PlayStation 5 Pro Console - 2TB', merchant = 'Ships from Amazon.com Sold by Amazon.com', price = '$899.99', buy = '<input id="add-to-cart-button" type="submit" value="Add to Cart">' } = {}) {
  return `<html><head><title>Amazon.com</title></head><body>
    <div id="centerCol"><span id="productTitle">${title}</span></div>
    <div id="desktop_buybox">
      <div id="corePrice_feature_div"><span class="a-offscreen">${price}</span></div>
      <div id="tabular-buybox">${merchant.split(' Sold by ').map((s, i) => (i ? `<span>Sold by</span> <span>${s}</span>` : `<span>${s}</span>`)).join(' ')}</div>
      ${buy}
    </div>
    <footer>Need help? Solve a captcha puzzle or contact us.</footer>
  </body></html>`;
}
const AMZ_URL = 'https://www.amazon.com/dp/B0EXAMPLE1';

test('Amazon: sold by Amazon.com is a buy (and the word captcha in a footer is not a bot wall)', () => {
  const r = detect('amazon', amazon(), AMZ_URL);
  assert.equal(r.state, 'in_stock');
  assert.equal(r.firstParty, true);
  assert.equal(D.evaluate(r, settings).ok, true);
});

test('Amazon: third-party seller is rejected', () => {
  assert.equal(detect('amazon', amazon({ merchant: 'Ships from Amazon.com Sold by Console Kings' }), AMZ_URL).firstParty, false);
});

test('Amazon: Amazon Resale is not treated as Amazon', () => {
  assert.equal(detect('amazon', amazon({ merchant: 'Ships from Amazon Sold by Amazon Resale' }), AMZ_URL).firstParty, false);
});

test('Amazon: Renewed is not new', () => {
  assert.equal(detect('amazon', amazon({ title: 'PlayStation 5 Pro Console (Renewed)' }), AMZ_URL).notNew, true);
});

test('Amazon: invite-only listing is reported as invite', () => {
  const r = detect('amazon', amazon({ buy: '<span class="a-button"><input type="submit" aria-label="Request invitation" value="Request invitation"></span>' }), AMZ_URL);
  assert.equal(r.state, 'invite');
});

test('Target: Target Plus partner listing is third party', () => {
  const html = `<html><body><main>
    <h1 data-test="product-title">PlayStation 5 Pro Console</h1>
    <span data-test="product-price">$1,149.99</span>
    <div data-test="targetPlusExtraInfoSection">Sold and shipped by GameStation Partners</div>
    <div data-test="flexible-fulfillment"><button data-test="shippingButton">Add to cart</button></div>
  </main></body></html>`;
  const r = detect('target', html, 'https://www.target.com/p/playstation-5-pro-console/-/A-93620188');
  assert.equal(r.firstParty, false);
  assert.equal(D.evaluate(r, settings).ok, false);
});

test('PlayStation Direct: JSON-LD only (fetched HTML, no buttons rendered yet)', () => {
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'PlayStation 5 Pro Console - 2TB', offers: { '@type': 'Offer', price: '899.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition' } };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><div id="root"></div></body></html>`;
  const r = detect('psdirect', html, 'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb');
  assert.equal(r.state, 'in_stock');
  assert.equal(r.price, 899.99);
  assert.equal(r.firstParty, true);
  assert.equal(D.evaluate(r, settings).ok, true);
});

test('GameStop: Pre-Owned selected is not new', () => {
  const html = `<html><body><main><div class="primary-details-row">
    <h1 class="product-name">Sony PlayStation 5 Pro Console</h1>
    <div class="condition-selector"><button>New</button><button class="selected">Pre-Owned</button></div>
    <span class="actual-price">$749.99</span>
    <button class="add-to-cart">Add to Cart</button></div></main></body></html>`;
  const r = detect('gamestop', html, 'https://www.gamestop.com/consoles-hardware/playstation-5/consoles/products/sony-playstation-5-pro-console/20015604.html');
  assert.equal(r.notNew, true);
  assert.equal(D.evaluate(r, settings).ok, false);
});

test('CAPTCHA page is blocked', () => {
  const html = '<html><head><title>Robot Check</title></head><body><form action="/errors/validateCaptcha"><p>Type the characters you see</p></form></body></html>';
  assert.equal(detect('amazon', html, AMZ_URL).state, 'blocked');
});

test('Akamai "Press & Hold" wall is blocked', () => {
  const html = '<html><body><div id="px-captcha"></div><p>Press & Hold to confirm you are a human (and not a bot).</p></body></html>';
  assert.equal(detect('walmart', html, WM_URL).state, 'blocked');
});

test("invisible reCAPTCHA on a normal page is not a bot check", () => {
  const html = bestBuy({
    extra: '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible"></iframe><div class="grecaptcha-badge"><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe></div>' + '<p>Product details. </p>'.repeat(400),
  });
  assert.equal(detect('bestbuy', html, BB_URL).state, 'in_stock');
});

test('a short page that is just a CAPTCHA widget is a bot check', () => {
  const html = '<html><body><p>One more step</p><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=normal"></iframe></body></html>';
  assert.equal(detect('bestbuy', html, BB_URL).state, 'blocked');
});

test('Queue-it waiting room is queue', () => {
  const html = '<html><body><h2 id="lbHeaderH2">You are now in line</h2><p>Your estimated wait time is 12 minutes</p></body></html>';
  assert.equal(detect('psdirect', html, 'https://sony.queue-it.net/?c=sony&e=ps5pro').state, 'queue');
});

test('parseMoney handles common formats', () => {
  assert.equal(D.parseMoney('$899.99'), 899.99);
  assert.equal(D.parseMoney('Now $1,299.00 was $1,399.00'), 1299);
  assert.equal(D.parseMoney('899.99'), 899.99);
  assert.equal(D.parseMoney('Sold out'), null);
});

test('product title must be a PS5 Pro, not a regular PS5 or an accessory', () => {
  const re = C.re(C.MATCH.productTitle);
  assert.ok(re.test('PlayStation®5 Pro Console - 2TB'));
  assert.ok(re.test('PS5 Pro Digital 2TB'));
  assert.ok(!re.test('PlayStation 5 Slim Console'));
  assert.ok(!re.test('PS5 Professional Charging Stand'));
});
