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
    const j = await (await fetch('/api/add' + location.search, { method: 'POST' })).json();
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
    const frame = document.querySelector('iframe');
    const cvv = document.getElementById('cvv') || (frame && frame.contentDocument.querySelector('input'));
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
    ${st.requireCvv && st.cvvInFrame ? '<iframe src="/payment/frame" title="Card" style="width:320px;height:60px;border:0"></iframe>' : ''}
    ${st.requireCvv && !st.cvvInFrame ? '<label>Security code <input id="cvv" name="cvv"></label>' : ''}
    ${placeButton}<p id="err"></p>`;
}

// Best Buy style: email and password on one page. Target style: email first,
// then the password box appears on the same page.
function signinHtml(style, ret) {
  const post = `async function login(remember) {
      const j = await (await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.querySelector('input[type=email]').value, password: document.querySelector('input[type=password]').value, remember, ret: ${JSON.stringify(ret)} }) })).json();
      if (j.ok) location.href = j.next; else document.getElementById('err').textContent = j.error;
    }`;
  if (style === 'single') {
    return shell(
      'Sign In - Best Buy',
      `<form id="f"><h1>Sign In</h1><input type="email" id="fld-e" name="email"><input type="password" id="fld-p1" name="password">
        <label><input type="checkbox" name="rememberMe"> Keep me signed in</label>
        <button type="submit" class="cia-form__controls__submit">Sign In</button><p id="err"></p></form>`,
      `${post}
      document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); login(document.querySelector('[name=rememberMe]').checked); });`
    );
  }
  return shell(
    'Sign in : Target',
    `<form id="f"><h1>Sign into your Target account</h1><input type="email" id="username">
      <div id="pw" hidden><input type="password" id="password"><label><input type="checkbox" id="keepMeSignedIn"> Keep me signed in</label></div>
      <button id="login" type="submit">Continue</button><p id="err"></p></form>`,
    `${post}
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw');
      if (pw.hidden) { pw.hidden = false; document.getElementById('login').textContent = 'Sign in'; return; }
      login(document.getElementById('keepMeSignedIn').checked);
    });`
  );
}

const OTP = shell('Verify', '<h1>Verify it\'s you</h1><p>Enter the verification code we sent to your phone.</p><input autocomplete="one-time-code" name="code"><button>Verify</button>');

const CAPTCHA = shell('Robot Check', '<form action="/errors/validateCaptcha"><p>Type the characters you see in this image.</p><input name="field-keywords"></form>');

const subtotal = (st) => st.cart.reduce((n, i) => n + i.price, 0);

const STORES = {
  'www.bestbuy.com': {
    id: 'bestbuy',
    pdp: '/site/6601524.p',
    signin: '/identity/signin',
    signinStyle: 'single',
    account: '/site/customer/myaccount',
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
    signin: '/login',
    signinStyle: 'email-first',
    account: '/account',
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
        ADD_SCRIPT('button[data-test="shippingButton"]') + `
        // Like the real page: ask for this product's stock (and a recommended
        // product's), and read the answers.
        fetch('/redsky_aggregations/v1/web/pdp_fulfillment_v1?key=9f36aeafbe&tcin=93620188&store_id=1234').then((r) => r.json());
        fetch('/redsky_aggregations/v1/web/pdp_fulfillment_v1?key=9f36aeafbe&tcin=11112222&store_id=1234').then((r) => r.json());`
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
          <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc&size=invisible" width="256" height="60"></iframe>
          <div class="grecaptcha-badge"><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=6Lc" width="256" height="60"></iframe></div>
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
  return {
    inStock: false,
    price: 899.99,
    seller: null,
    cart: [],
    pleaseWaitMs: 0,
    waited: false,
    requireCvv: false,
    cvvInFrame: false,
    captchaAtCheckout: false,
    requireLogin: false,
    otp: false,
    creds: { email: 'me@example.com', password: 'hunter2!' },
    logins: [],
    adds: 0,
    pdpHits: 0,
    apiHits: 0,
    pickupInStock: false,
    altInStock: false, // Best Buy's second listing (SKU 6609999)
    cartViewed: false,
    refuseQuick: false,
    refused: 0,
  };
}

function createServer({ key, cert, port = 443 }) {
  const state = { stores: {}, orders: [], ntfy: [], subs: {}, discord: [] };
  // A restock bot posting in the Discord channel.
  state.discordPost = (title, fields = '', link = '') => state.discord.push({ id: 1000 + state.discord.length, at: new Date().toISOString(), title, fields, link });
  // Push a message to everyone listening on an ntfy topic (GET /topic/json).
  state.publish = (topic, message) => {
    const line = JSON.stringify({ event: 'message', topic, message }) + '\n';
    for (const res of state.subs[topic] || []) res.write(line);
  };
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
      const json = (obj, headers = {}) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(obj));
      };
      const redirect = (to) => {
        res.writeHead(302, { Location: to });
        res.end();
      };

      if (host === 'discord.com') {
        if (url.pathname === '/api/mock/messages') {
          const after = +url.searchParams.get('after') || 0;
          return json(state.discord.filter((m) => m.id > after));
        }
        // Looks enough like Discord's channel view: history, then new posts with embeds.
        const old = new Date(Date.now() - 3600000).toISOString();
        return send(
          200,
          shell(
            'restock-alerts | Discord',
            `<main><ol data-list-id="chat-messages">
              <li id="chat-messages-2-1"><time datetime="${old}">1h</time><div>PS5 Pro in stock at Target! (an hour ago)</div></li>
            </ol></main>`,
            `let last = 0;
            setInterval(async () => {
              const msgs = await (await fetch('/api/mock/messages?after=' + last)).json();
              for (const m of msgs) {
                last = m.id;
                const li = document.createElement('li');
                li.id = 'chat-messages-2-' + m.id;
                li.innerHTML = '<time datetime="' + m.at + '">now</time><div id="message-content-' + m.id + '"></div>';
                document.querySelector('ol').appendChild(li);
                // The bot's card renders a moment later, like Discord embeds.
                setTimeout(() => {
                  li.insertAdjacentHTML('beforeend', '<article class="embedWrapper"><div class="embedTitle">' + m.title + '</div><div class="embedFields">' + m.fields + '</div>' + (m.link ? '<a href="' + m.link + '">Buy</a>' : '') + '</article>');
                }, 200);
              }
            }, 300);`
          )
        );
      }
      if (host === 'ntfy.sh') {
        const m = url.pathname.match(/^\/([^/]+)\/json$/);
        if (m && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.write(JSON.stringify({ event: 'open', topic: m[1] }) + '\n');
          (state.subs[m[1]] = state.subs[m[1]] || []).push(res);
          res.on('close', () => (state.subs[m[1]] = state.subs[m[1]].filter((r) => r !== res)));
          return;
        }
        const topic = url.pathname.slice(1);
        state.ntfy.push({ topic, title: req.headers.title || '', priority: req.headers.priority, body });
        state.publish(topic, body);
        return json({ id: String(state.ntfy.length) });
      }
      const def = STORES[host];
      if (!def) return send(404, 'unknown host');
      const st = state.stores[def.id];
      const p = url.pathname;
      const authed = /(?:^|;\s*)auth=1/.test(req.headers.cookie || '');
      const needsLogin = st.requireLogin && !authed;

      if (def.signin && p === def.signin) return send(200, signinHtml(def.signinStyle, url.searchParams.get('return') || def.account));
      if (p === '/identity/otp') return send(200, OTP);
      if (p === '/api/login' && req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        if (b.email !== st.creds.email || b.password !== st.creds.password) return json({ ok: false, error: 'Wrong email or password' });
        st.logins.push({ email: b.email, remember: !!b.remember });
        if (st.otp) return json({ ok: true, next: '/identity/otp' });
        return json({ ok: true, next: b.ret || '/' }, { 'Set-Cookie': 'auth=1; Path=/; Secure; SameSite=Lax' });
      }
      if (def.account && p === def.account) {
        if (needsLogin) return redirect(`${def.signin}?return=${encodeURIComponent(p)}`);
        return send(200, shell('Account', '<header><a href="/account">Hi, Austin</a></header><h1>Your account</h1>'));
      }
      if (p === '/payment/frame') return send(200, shell('Card', '<label>Security code <input autocomplete="cc-csc" name="cvv"></label>'));
      if (p === def.checkout && needsLogin) return redirect(`${def.signin}?return=${encodeURIComponent(p)}`);

      // Bot protection that turns away background requests but lets real page loads through.
      const isQuickCheck = req.headers['sec-fetch-mode'] !== 'navigate' && (p === def.pdp || p.startsWith('/button-state/') || p.startsWith('/redsky_'));
      if (st.refuseQuick && isQuickCheck) {
        st.refused++;
        return send(403, shell('Access Denied', "<h1>Access Denied</h1><p>You don't have permission to access this resource.</p>"));
      }
      const alt = def.id === 'bestbuy' && url.searchParams.get('skuId') === '6609999';
      const view = alt ? { ...st, inStock: st.altInStock } : st;
      if (p === def.pdp || (def.id === 'bestbuy' && p === '/site/6609999.p')) {
        st.pdpHits++;
        return send(200, def.pdpHtml(view));
      }
      // Best Buy's small stock lookup.
      if (p === '/button-state/api/v5/button-state') {
        st.apiHits++;
        const sku = url.searchParams.get('skus');
        const inStock = sku === '6609999' ? st.altInStock : st.inStock;
        return json([{ skuId: sku, buttonState: inStock ? 'ADD_TO_CART' : 'SOLD_OUT', displayText: inStock ? 'Add to Cart' : 'Sold Out' }]);
      }
      // Target's stock request (the page calls it; the extension learns it).
      if (p === '/redsky_aggregations/v1/web/pdp_fulfillment_v1') {
        if (url.searchParams.get('tcin') === '93620188') st.apiHits++;
        const mine = url.searchParams.get('tcin') === '93620188';
        return json({
          data: {
            product: {
              tcin: url.searchParams.get('tcin'),
              fulfillment: {
                store_options: [{ order_pickup: { availability_status: st.pickupInStock || !mine ? 'IN_STOCK' : 'OUT_OF_STOCK' } }],
                shipping_options: { availability_status: mine && st.inStock ? 'IN_STOCK' : mine ? 'OUT_OF_STOCK' : 'IN_STOCK' },
              },
            },
          },
        });
      }
      // Walmart won't open checkout until you've been through the cart.
      if (def.id === 'walmart' && p === '/checkout') return redirect(st.cartViewed ? def.checkout : def.cart);
      if (p === '/api/add' && req.method === 'POST') {
        if (!view.inStock) return json({ ok: false, error: 'Sold out' });
        if (st.pleaseWaitMs && !st.waited) {
          st.waited = true;
          return json({ wait: st.pleaseWaitMs });
        }
        st.adds++;
        st.cart.push({ name: PRODUCT, price: st.price });
        return json({ ok: true });
      }
      if (p === def.cart) {
        st.cartViewed = true;
        return send(200, shell('Cart', cartBody(st, def.cartButton)));
      }
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

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state, hosts: Object.keys(STORES).concat('ntfy.sh', 'discord.com') })));
}

module.exports = { createServer, freshStoreState, STORES };
