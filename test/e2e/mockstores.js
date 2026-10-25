// Fake Best Buy, Target and Walmart (plus ntfy.sh) served over local HTTPS, so the
// real extension can be driven end to end in Chromium. The markup mirrors the
// selectors in extension/lib/config.js; it proves the engine, not the real sites.
const https = require('https');

const PRODUCT = 'PlayStation 5 Pro Console';

function shell(title, body, script = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;
}

const ADD_SCRIPT = (sel) => `
  const btn = document.querySelector(${JSON.stringify(sel)});
  if (btn) btn.addEventListener('click', async () => {
    const j = await (await fetch('/api/add', { method: 'POST' })).json();
    if (j.wait) {
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Please Wait...';
      setTimeout(() => { btn.disabled = false; btn.textContent = label; }, j.wait);
      return;
    }
    document.getElementById('msg').textContent = j.ok ? 'Added to cart' : j.error;
  });`;

const PLACE_SCRIPT = (sel, thanks) => `
  document.querySelector(${JSON.stringify(sel)}).addEventListener('click', async () => {
    const cvv = document.getElementById('cvv');
    const j = await (await fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cvv: cvv ? cvv.value : null }) })).json();
    if (j.ok) location.href = ${JSON.stringify(thanks)};
    else document.getElementById('err').textContent = j.error;
  });`;

function cartBody(st, checkoutButton) {
  if (!st.cart.length) return '<h1>Your cart is empty</h1>';
  return `<h1>Cart</h1><ul>${st.cart.map((i) => `<li>${i.name} x1 $${i.price.toFixed(2)}</li>`).join('')}</ul>
    <div class="summary"><span>Subtotal</span> <span>$${subtotal(st).toFixed(2)}</span></div>${checkoutButton}`;
}

function checkoutBody(st, placeButton) {
  if (st.captchaAtCheckout) return null;
  return `<h1>Review your order</h1>
    <p>Your order confirmation will be emailed to you.</p>
    ${st.cart.map((i) => `<div class="item">${i.name}</div>`).join('')}
    <div class="row"><span>Subtotal</span><span>$${subtotal(st).toFixed(2)}</span></div>
    <div class="row"><span>Estimated tax</span><span>$${(subtotal(st) * 0.08).toFixed(2)}</span></div>
    ${st.requireCvv ? '<label>Security code <input id="cvv" name="cvv"></label>' : ''}
    ${placeButton}<p id="err"></p>`;
}

const CAPTCHA = shell('Robot Check', '<form action="/errors/validateCaptcha"><p>Type the characters you see in this image.</p><input name="field-keywords"></form>');

const subtotal = (st) => st.cart.reduce((n, i) => n + i.price, 0);

const STORES = {
  'www.bestbuy.com': {
    id: 'bestbuy',
    pdp: '/site/6601524.p',
    cart: '/cart',
    checkout: '/checkout/r/fast-track',
    thanks: '/checkout/r/thank-you',
    pdpHtml: (st) =>
      shell(
        `${PRODUCT} - Best Buy`,
        `<main><h1>${PRODUCT}</h1>
          <div data-testid="customer-price"><span>$${st.price.toFixed(2)}</span></div>
          ${st.seller ? `<div data-testid="marketplace-seller">Sold by ${st.seller}</div>` : ''}
          <div class="fulfillment-add-to-cart-button"><button class="add-to-cart-button" data-button-state="${st.inStock ? 'ADD_TO_CART' : 'SOLD_OUT'}" ${st.inStock ? '' : 'disabled'}>${st.inStock ? 'Add to Cart' : 'Sold Out'}</button></div>
          <div id="msg"></div></main>
          <section class="carousel"><h2>Customers also bought</h2><button>Add to Cart</button></section>`,
        ADD_SCRIPT('button.add-to-cart-button')
      ),
    cartButton: '<div class="checkout-buttons__checkout"><button onclick="location.href=\'/checkout/r/fast-track\'">Checkout</button></div>',
    placeButton: '<button class="button__fast-track">Place Your Order</button>',
    placeSel: 'button.button__fast-track',
  },
  'www.target.com': {
    id: 'target',
    pdp: '/p/playstation-5-pro-console/-/A-93620188',
    cart: '/cart',
    checkout: '/checkout',
    thanks: '/order-confirmation',
    pdpHtml: (st) =>
      shell(
        `${PRODUCT} : Target`,
        `<main><h1 data-test="product-title">${PRODUCT}</h1>
          <span data-test="product-price">$${st.price.toFixed(2)}</span>
          ${st.seller ? `<div data-test="targetPlusExtraInfoSection">Sold and shipped by ${st.seller}</div>` : ''}
          <div data-test="flexible-fulfillment">${st.inStock ? '<button data-test="shippingButton">Add to cart</button>' : '<button data-test="shippingButton" disabled>Out of stock</button>'}</div>
          <div id="msg"></div></main>`,
        ADD_SCRIPT('button[data-test="shippingButton"]')
      ),
    cartButton: '<button data-test="checkout-button" onclick="location.href=\'/checkout\'">Check out</button>',
    placeButton: '<button data-test="placeOrderButton">Place your order</button>',
    placeSel: 'button[data-test="placeOrderButton"]',
  },
  'www.walmart.com': {
    id: 'walmart',
    pdp: '/ip/Sony-PlayStation-5-Pro-Console-PS5-Pro/18235967161',
    cart: '/cart',
    checkout: '/checkout/review-order',
    thanks: '/checkout/thankyou',
    pdpHtml: (st) => {
      const product = { name: 'Sony ' + PRODUCT, usItemId: '18235967161', availabilityStatus: st.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK', sellerDisplayName: st.seller || 'Walmart.com', priceInfo: { currentPrice: { price: st.price } } };
      return shell(
        `Sony ${PRODUCT} - Walmart.com`,
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { product } } } } })}</script>
          <main><h1 id="main-title">Sony ${PRODUCT}</h1>
          <span itemprop="price">$${st.price.toFixed(2)}</span>
          <div data-testid="product-seller-info">Sold and shipped by ${st.seller || 'Walmart.com'}</div>
          <div data-testid="add-to-cart-section">${st.inStock ? '<button data-automation-id="atc">Add to cart</button>' : '<button data-automation-id="atc" disabled>Out of stock</button>'}</div>
          <div id="msg"></div></main>`,
        ADD_SCRIPT('button[data-automation-id="atc"]')
      );
    },
    cartButton: '<button data-automation-id="checkout" onclick="location.href=\'/checkout/review-order\'">Continue to checkout</button>',
    placeButton: '<button data-automation-id="place-order-button">Place order</button>',
    placeSel: 'button[data-automation-id="place-order-button"]',
  },
};

function freshStoreState() {
  return { inStock: false, price: 899.99, seller: null, cart: [], pleaseWaitMs: 0, waited: false, requireCvv: false, captchaAtCheckout: false, adds: 0, pdpHits: 0 };
}

function createServer({ key, cert, port = 443 }) {
  const state = { stores: {}, orders: [], ntfy: [] };
  for (const s of Object.values(STORES)) state.stores[s.id] = freshStoreState();

  const server = https.createServer({ key, cert }, (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url, `https://${host}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, content, type = 'text/html') => {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(content);
      };
      const json = (obj) => send(200, JSON.stringify(obj), 'application/json');

      if (host === 'ntfy.sh') {
        state.ntfy.push({ topic: url.pathname.slice(1), title: req.headers.title || '', priority: req.headers.priority, body });
        return json({ id: String(state.ntfy.length) });
      }
      const def = STORES[host];
      if (!def) return send(404, 'unknown host');
      const st = state.stores[def.id];
      const p = url.pathname;

      if (p === def.pdp) {
        st.pdpHits++;
        return send(200, def.pdpHtml(st));
      }
      if (p === '/api/add' && req.method === 'POST') {
        if (!st.inStock) return json({ ok: false, error: 'Sold out' });
        if (st.pleaseWaitMs && !st.waited) {
          st.waited = true;
          return json({ wait: st.pleaseWaitMs });
        }
        st.adds++;
        st.cart.push({ name: PRODUCT, price: st.price });
        return json({ ok: true });
      }
      if (p === def.cart) return send(200, shell('Cart', cartBody(st, def.cartButton)));
      if (p === def.checkout) {
        const inner = checkoutBody(st, def.placeButton);
        return send(200, inner == null ? CAPTCHA : shell('Checkout', inner, PLACE_SCRIPT(def.placeSel, def.thanks)));
      }
      if (p === '/api/order' && req.method === 'POST') {
        const { cvv } = JSON.parse(body || '{}');
        if (st.requireCvv && cvv !== '123') return json({ ok: false, error: 'Please enter a valid security code' });
        if (!st.cart.length) return json({ ok: false, error: 'Your cart is empty' });
        state.orders.push({ store: def.id, items: st.cart.length, subtotal: subtotal(st), cvv });
        st.cart = [];
        return json({ ok: true });
      }
      if (p === def.thanks) return send(200, shell('Order confirmed', '<h1>Thank you for your order!</h1><p>Order #1001</p>'));
      return send(404, shell('Not found', '<h1>Page not found</h1>'));
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state, hosts: Object.keys(STORES).concat('ntfy.sh') })));
}

module.exports = { createServer, freshStoreState, STORES };
