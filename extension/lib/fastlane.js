// Speed helpers: read stock from a store's small JSON/HTML stock responses
// instead of a whole product page, decide when to check faster ("hot" and
// "warm"), and understand outside restock alerts.
(function (root) {
  const C = root.PS5Config || (typeof require !== 'undefined' ? require('./config.js') : null);
  const D = root.PS5Detect || (typeof require !== 'undefined' ? require('./detect.js') : null);

  // ---------------------------------------------------------------- stock JSON

  const IN = /^(in_?stock|available|add_to_cart|buy_now|limited_stock|low_?stock|limited_availability|pre_?order_sellable|orderable)$/;
  const OUT = /^(out_?of_?stock|sold_?out|unavailable|not_available|coming_soon|check_stores|discontinued|no_stock|not_sold_online|back_?order(ed)?)$/;
  const STATUS_KEY = /^(availability_?status|stock_?level_?status|stock_?status|button_?state|inventory_?status|availability|status|purchasability)$/i;
  const BOOL_KEY = /^(in_?stock|is_?in_?stock|is_?available_?online|is_?orderable|orderable|available_?for_?purchase)$/i;

  // "inStock" / "IN_STOCK" / "in stock" -> "in_stock"
  const norm = (v) => String(v).trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');

  function collect(obj, path, out, budget) {
    if (!obj || typeof obj !== 'object' || budget.n-- <= 0) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'string' && STATUS_KEY.test(k)) {
        const n = norm(v);
        if (IN.test(n)) out.push({ path: p, value: v, inStock: true });
        else if (OUT.test(n)) out.push({ path: p, value: v, inStock: false });
      } else if (typeof v === 'boolean' && BOOL_KEY.test(k)) {
        out.push({ path: p, value: v, inStock: v });
      } else if (v && typeof v === 'object') {
        collect(v, p, out, budget);
      }
    }
  }

  // Works on any of the stores' stock responses we know of (Best Buy button
  // state, Target fulfillment, PlayStation Direct stock level, Walmart item
  // data) and on unknown ones that use similar field names. Shipping
  // availability wins over in-store pickup, since that's what we buy.
  function parseStockJson(json) {
    const hits = [];
    collect(json, '', hits, { n: 5000 });
    if (!hits.length) return { state: 'unknown' };
    const ship = hits.filter((h) => /ship|online|deliver/i.test(h.path));
    const notStore = hits.filter((h) => !/store|pickup|nearby|locations/i.test(h.path));
    const pick = (ship.length ? ship : notStore.length ? notStore : hits)[0];
    return { state: pick.inStock ? 'in_stock' : 'out_of_stock', signal: `${pick.path}=${pick.value}` };
  }

  // ---------------------------------------------------------------- Amazon offers

  // Amazon's "other sellers" panel (about 9 KB instead of the 400 KB product
  // page). In stock only if one offer is new, sold by Amazon and under the cap,
  // so the $1,200 third-party offers that are always listed don't count.
  function parseAod(doc, store, settings) {
    const blocks = doc.querySelectorAll('#aod-pinned-offer, #aod-offer, .aod-information-block, .aod-other-offer-block, [id^="aod-offer-"][id$="-list"] > div');
    const seller = C.re(store.firstPartySeller || 'sold by\\s*:?\\s*amazon(\\.com)?\\b');
    const notNew = C.re(C.MATCH.notNew);
    let offers = 0;
    let best = null;
    for (const el of blocks) {
      const text = D.textOf(el, 3000);
      if (!/\$\s*\d/.test(text)) continue;
      offers++;
      const priceEl = el.querySelector('.a-price .a-offscreen, .a-offscreen');
      const price = D.parseMoney(priceEl ? priceEl.textContent : text);
      const headEl = el.querySelector('#aod-offer-heading, [id^="aod-offer-heading"]');
      const condition = headEl ? D.textOf(headEl, 200) : text;
      const soldByEl = el.querySelector('#aod-offer-soldBy, [id^="aod-offer-soldBy"]');
      const soldBy = soldByEl ? D.textOf(soldByEl, 300) : text;
      const isNew = /\bnew\b/i.test(condition) && !notNew.test(condition);
      if (isNew && seller.test(soldBy) && price != null && price <= settings.priceCap + 0.005 && price >= settings.minPrice) {
        if (!best || price < best.price) best = { price };
      }
    }
    if (best) return { state: 'in_stock', price: best.price, firstParty: true, signal: 'amazon offer' };
    return { state: offers ? 'out_of_stock' : 'unknown', signal: `${offers} offers, none from Amazon at or under the cap` };
  }

  // ---------------------------------------------------------------- lanes

  function productId(store, url) {
    const f = store.fast || {};
    if (!f.idFrom) return null;
    const m = String(url).match(C.re(f.idFrom, ''));
    return m ? m.slice(1).find(Boolean) || null : null;
  }

  function templateUrl(store, url) {
    const f = store.fast || {};
    const id = productId(store, url);
    return f.template && id ? f.template.replace('{id}', encodeURIComponent(id)) : null;
  }

  // A request the page made that looks like its own stock check for this product.
  function isLearnable(store, pageUrl, requestUrl) {
    const f = store.fast || {};
    if (!(f.learn || []).some((src) => C.re(src).test(requestUrl))) return false;
    const id = productId(store, pageUrl);
    return !id || requestUrl.includes(id);
  }

  // ---------------------------------------------------------------- hot / warm

  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // "Mon-Fri 07:00-12:00; Sat 09:00-11:00" (Eastern time) -> window objects.
  function parseWindows(text) {
    const out = [];
    for (const part of String(text || '').split(/[;\n]+/)) {
      const m = part.trim().match(/^([a-z,\- ]+?)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/i);
      if (!m) continue;
      const days = new Set();
      for (const chunk of m[1].toLowerCase().split(/\s*,\s*/)) {
        const [a, b] = chunk.split(/\s*-\s*/).map((d) => DAYS.indexOf(d.slice(0, 3)));
        if (a < 0 || (b !== undefined && b < 0)) continue;
        if (b === undefined) days.add(a);
        else for (let d = a; ; d = (d + 1) % 7) {
          days.add(d);
          if (d === b) break;
        }
      }
      if (days.size) out.push({ days: [...days].sort(), start: +m[2] * 60 + +m[3], end: +m[4] * 60 + +m[5] });
    }
    return out;
  }

  function easternParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    return { day: DAYS.indexOf(get('weekday').toLowerCase().slice(0, 3)), minutes: +get('hour') * 60 + +get('minute') };
  }

  function inWindows(date, windows) {
    if (!windows.length) return false;
    const { day, minutes } = easternParts(date);
    return windows.some((w) => w.days.includes(day) && minutes >= w.start && minutes < w.end);
  }

  // ---------------------------------------------------------------- outside alerts

  const STORE_NAMES = {
    psdirect: /playstation\s*direct|ps\s*direct|direct\.playstation|sony\s*(direct|store)/i,
    bestbuy: /best\s*buy/i,
    target: /\btarget\b/i,
    walmart: /walmart/i,
    amazon: /amazon/i,
    gamestop: /game\s*stop/i,
  };

  // A restock alert ("PS5 Pro in stock at Target!"), with any links in it.
  // Returns which stores to check now and which product links to open; not
  // matched when it isn't about a PS5 Pro.
  function parseTrigger(text, opts = {}, links = []) {
    const t = String(text || '');
    if (!opts.anyProduct && !C.re(C.MATCH.productTitle).test(t)) return { matched: false, stores: [], links: [] };
    const stores = Object.keys(STORE_NAMES).filter((id) => STORE_NAMES[id].test(t));
    const productLinks = [];
    for (const href of links) {
      let host;
      try {
        host = new URL(href).hostname;
      } catch (_) {
        continue;
      }
      const id = C.storeForHost(host);
      const pdp = id && C.STORES[id].checkout.steps.find((s) => s.id === 'pdp');
      if (!pdp || !C.re(pdp.url).test(href)) continue;
      if (!stores.includes(id)) stores.push(id);
      if (!productLinks.some((l) => l.url === href)) productLinks.push({ storeId: id, url: href });
    }
    return { matched: true, stores, links: productLinks };
  }

  const api = { parseStockJson, parseAod, productId, templateUrl, isLearnable, parseWindows, inWindows, easternParts, parseTrigger };
  root.PS5Fast = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
