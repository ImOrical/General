// Reads a store page (the live DOM or HTML fetched in the background) and works
// out whether a new, first-party PS5 Pro is buyable and at what price.
(function (root) {
  const C = root.PS5Config || (typeof require !== 'undefined' ? require('./config.js') : null);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME']);
  const CLICKABLE = 'button, a, input[type="submit"], input[type="button"], [role="button"]';
  const CAPTCHA_SELECTORS = [
    '#px-captcha',
    'form[action*="validateCaptcha"]',
    'iframe[src*="captcha"]',
    '#sec-if-cpt-container',
    '#challenge-container',
    '.g-recaptcha[data-size="normal"]',
    'iframe[src*="hcaptcha"]',
  ];
  const QUEUE_SELECTORS = ['#MainPart_divProgressbar', '#queue-it_log', '[id^="queue-it"]', '#lbHeaderH2'];

  // Visible-ish text with script/style skipped and text nodes separated by spaces,
  // so "Sold by" + "Amazon.com" in two spans reads as "Sold by Amazon.com".
  function textOf(node, limit = 200000) {
    if (!node) return '';
    const parts = [];
    let len = 0;
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const t = c.nodeValue.trim();
          if (t) {
            parts.push(t);
            len += t.length + 1;
            if (len > limit) return true;
          }
        } else if (c.nodeType === 1) {
          if (SKIP_TAGS.has(c.tagName.toUpperCase()) || c.hidden) continue;
          if (walk(c)) return true;
        }
      }
      return false;
    };
    walk(node);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function labelOf(el) {
    const t = textOf(el, 300);
    if (t) return t;
    return (el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
  }

  function first(doc, selectors) {
    for (const sel of selectors || []) {
      try {
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch (_) {
        // A bad selector in user overrides shouldn't stop detection.
      }
    }
    return null;
  }

  function all(rootEl, sel) {
    try {
      return Array.from(rootEl.querySelectorAll(sel));
    } catch (_) {
      return [];
    }
  }

  function isEnabled(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) return false;
    const cls = el.getAttribute('class') || '';
    if (/\b(is-)?disabled\b|btn-disabled|button--disabled/i.test(cls)) return false;
    const state = el.getAttribute('data-button-state');
    if (state && !/ADD_TO_CART|PRE_ORDER/i.test(state)) return false;
    return true;
  }

  function isVisible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const view = el.ownerDocument.defaultView;
    if (!view) return true;
    const cs = view.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // Finds the button described by spec ({selectors, text, scope}). Returns the first
  // enabled match and, separately, the first disabled one (e.g. "Sold Out", "Please Wait").
  function findClickable(doc, spec, opts = {}) {
    const scopeEl = first(doc, spec.scope) || doc;
    const textRe = spec.text ? C.re(spec.text) : null;
    const seen = new Set();
    const candidates = [];
    for (const sel of spec.selectors || []) {
      for (const el of all(scopeEl, sel)) if (!seen.has(el)) seen.add(el), candidates.push(el);
    }
    if (textRe) {
      for (const el of all(scopeEl, CLICKABLE)) {
        if (!seen.has(el) && textRe.test(labelOf(el))) seen.add(el), candidates.push(el);
      }
    }
    let enabled = null;
    let disabled = null;
    for (const el of candidates) {
      if (opts.live && !isVisible(el)) continue;
      if (isEnabled(el)) {
        if (!enabled) enabled = el;
      } else if (!disabled) {
        disabled = el;
      }
    }
    return { el: enabled, disabled };
  }

  function parseMoney(str) {
    if (str == null) return null;
    const s = String(str);
    const m = s.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/) || s.match(/^\s*([\d,]+\.\d{2})\s*$/) || s.match(/^\s*(\d+(?:\.\d{1,2})?)\s*$/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function lastSegment(v) {
    if (!v) return null;
    return String(v).split('/').pop();
  }

  function asArray(v) {
    return v == null ? [] : Array.isArray(v) ? v : [v];
  }

  function hasType(node, type) {
    return asArray(node['@type']).some((t) => String(t).toLowerCase() === type);
  }

  // schema.org Product/Offer data, which most of these stores embed for search engines.
  function jsonLd(doc) {
    const out = { name: null, offers: [] };
    const visit = (node, depth) => {
      if (!node || depth > 6) return;
      if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
      if (typeof node !== 'object') return;
      if (node['@graph']) visit(node['@graph'], depth + 1);
      if (hasType(node, 'product') || hasType(node, 'productgroup')) {
        if (!out.name && node.name) out.name = String(node.name);
        for (const o of asArray(node.offers)) {
          const offers = hasType(o, 'aggregateoffer') && o.offers ? asArray(o.offers) : [o];
          for (const offer of offers) {
            out.offers.push({
              price: parseMoney(offer.price != null ? String(offer.price) : offer.priceSpecification && String(offer.priceSpecification.price)) ?? parseMoney(offer.lowPrice != null ? String(offer.lowPrice) : null),
              availability: lastSegment(offer.availability),
              condition: lastSegment(offer.itemCondition),
              seller: offer.seller && (offer.seller.name || (typeof offer.seller === 'string' ? offer.seller : null)),
            });
          }
        }
        if (node.hasVariant) visit(node.hasVariant, depth + 1);
      }
    };
    for (const s of all(doc, 'script[type="application/ld+json"]')) {
      try {
        visit(JSON.parse(s.textContent), 0);
      } catch (_) {
        // Malformed JSON-LD is common; ignore it.
      }
    }
    return out;
  }

  function deepFind(obj, pred, budget = { n: 20000 }) {
    if (!obj || typeof obj !== 'object' || budget.n-- <= 0) return null;
    if (!Array.isArray(obj) && pred(obj)) return obj;
    for (const v of Object.values(obj)) {
      const hit = deepFind(v, pred, budget);
      if (hit) return hit;
    }
    return null;
  }

  // Walmart ships the product's state in a Next.js JSON blob.
  function nextData(doc) {
    const el = doc.getElementById ? doc.getElementById('__NEXT_DATA__') : doc.querySelector('#__NEXT_DATA__');
    if (!el) return null;
    let data;
    try {
      data = JSON.parse(el.textContent);
    } catch (_) {
      return null;
    }
    const path = data && data.props && data.props.pageProps && data.props.pageProps.initialData;
    const product =
      (path && path.data && path.data.product) ||
      deepFind(data, (o) => 'availabilityStatus' in o && ('usItemId' in o || 'priceInfo' in o));
    if (!product) return null;
    const price = product.priceInfo && product.priceInfo.currentPrice && product.priceInfo.currentPrice.price;
    return {
      name: product.name || null,
      availability: product.availabilityStatus || null,
      price: typeof price === 'number' ? price : parseMoney(price),
      seller: product.sellerDisplayName || product.sellerName || null,
      condition: product.conditionType || (product.condition && product.condition.name) || null,
    };
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (_) {
      return '';
    }
  }

  function readPrice(doc, selectors) {
    for (const sel of selectors || []) {
      for (const el of all(doc, sel)) {
        const p = parseMoney(el.getAttribute('content')) ?? parseMoney(textOf(el, 100));
        if (p != null) return p;
      }
    }
    return null;
  }

  function isBlocked(doc, bodyText) {
    if (first(doc, CAPTCHA_SELECTORS)) return true;
    const title = (doc.title || '').trim();
    if (/robot check|access denied|captcha|attention required|just a moment/i.test(title)) return true;
    return bodyText.length < 4000 && C.re(C.MATCH.blocked).test(bodyText);
  }

  function isQueue(doc, url, bodyText) {
    if (/(^|\.)queue-it\.net$/i.test(hostOf(url))) return true;
    if (first(doc, QUEUE_SELECTORS)) return true;
    return bodyText.length < 6000 && C.re(C.MATCH.queue).test(bodyText);
  }

  // 'blocked' (CAPTCHA / bot wall), 'queue' (waiting room) or null.
  function gate(doc, url) {
    const bodyText = textOf(doc.body, 8000);
    if (isBlocked(doc, bodyText)) return 'blocked';
    if (isQueue(doc, url, bodyText)) return 'queue';
    return null;
  }

  // Main entry point. opts.live = true when reading the rendered page (enables
  // visibility checks, which a fetched, never-rendered document can't do).
  function detect(doc, store, url, opts = {}) {
    const d = store.detect || {};
    const M = C.MATCH;
    const base = { at: Date.now(), url, source: opts.live ? 'live' : 'fetch' };
    const g = gate(doc, url);
    if (g) return { ...base, state: g };

    const ld = jsonLd(doc);
    const nd = (store.extractors || []).includes('nextData') ? nextData(doc) : null;
    const mainOffer = ld.offers[0] || null;

    const titleEl = first(doc, d.titleSelectors);
    const title = (titleEl && textOf(titleEl, 400)) || ld.name || (nd && nd.name) || doc.title || '';

    const buy = findClickable(doc, { ...(d.buy || {}), scope: d.scope }, { live: !!opts.live });
    const scopeEl = first(doc, d.scope) || doc.body;
    const scopeText = textOf(scopeEl, 30000);
    const oosText = C.re(M.oos).test(scopeText);
    const invite = d.inviteText ? findClickable(doc, { selectors: [], text: d.inviteText, scope: d.scope }, { live: !!opts.live }) : null;

    const ndAvail = nd && nd.availability;
    const ldAvail = mainOffer && mainOffer.availability;

    let state = 'unknown';
    if (buy.el) state = 'in_stock';
    else if (invite && (invite.el || invite.disabled)) state = 'invite';
    else if (buy.disabled || oosText) state = 'out_of_stock';
    else if (ndAvail) state = /^IN_STOCK$/i.test(ndAvail) ? 'in_stock' : 'out_of_stock';
    else if (ldAvail) {
      if (/^(InStock|LimitedAvailability|OnlineOnly)$/i.test(ldAvail)) state = 'in_stock';
      else if (/^(OutOfStock|SoldOut|Discontinued|InStoreOnly)$/i.test(ldAvail)) state = 'out_of_stock';
    }

    const price = readPrice(doc, d.priceSelectors) ?? (nd && nd.price) ?? (mainOffer && mainOffer.price) ?? null;

    let sellerText = '';
    for (const sel of d.sellerSelectors || []) {
      const el = first(doc, [sel]);
      if (el) sellerText += ' ' + textOf(el, 600);
    }
    sellerText = sellerText.trim() || (nd && nd.seller) || (mainOffer && mainOffer.seller) || '';

    let firstParty;
    if (store.firstPartySeller == null) firstParty = true;
    else if (sellerText) firstParty = C.re(store.firstPartySeller).test(sellerText);
    else firstParty = store.sellerMissingMeansFirstParty ? true : null;

    let conditionText = '';
    for (const sel of d.conditionSelectors || []) {
      const el = first(doc, [sel]);
      if (el) conditionText += ' ' + textOf(el, 200);
    }
    const notNewRe = C.re(M.notNew);
    const notNew =
      notNewRe.test(title) ||
      notNewRe.test(conditionText) ||
      (nd && nd.condition && !/new/i.test(nd.condition)) ||
      (mainOffer && mainOffer.condition && /refurb|used|damaged/i.test(mainOffer.condition)) ||
      false;

    return {
      ...base,
      state,
      title: title.slice(0, 160),
      productMatch: C.re(M.productTitle).test(title),
      notNew: !!notNew,
      price,
      seller: String(sellerText).slice(0, 160),
      firstParty,
      buyLabel: buy.el ? labelOf(buy.el).slice(0, 40) : buy.disabled ? labelOf(buy.disabled).slice(0, 40) : null,
      signals: { button: buy.el ? 'enabled' : buy.disabled ? 'disabled' : 'none', oosText, ld: ldAvail || null, nextData: ndAvail || null },
    };
  }

  // Should we buy this? `alert` is true when a human should look even though we
  // won't buy automatically (e.g. we couldn't confirm the seller).
  function evaluate(result, settings) {
    const no = (reason, alert = false) => ({ ok: false, alert, reasons: [reason] });
    if (!result || result.state !== 'in_stock') return no('not in stock');
    if (!result.productMatch) return no('page title does not look like a PS5 Pro');
    if (result.notNew) return no('not new (refurbished, used or open-box)');
    if (result.firstParty === false) return no('sold by a third-party seller');
    if (result.price == null) return no('in stock but the price could not be read', true);
    if (result.price > settings.priceCap + 0.005) return no(`price $${result.price.toFixed(2)} is over your $${settings.priceCap} cap`);
    if (result.price < settings.minPrice) return no(`price $${result.price.toFixed(2)} looks wrong (under $${settings.minPrice})`, true);
    if (result.firstParty == null) return no('in stock but the seller could not be confirmed', true);
    return { ok: true, alert: true, reasons: [] };
  }

  const api = { textOf, labelOf, findClickable, isEnabled, parseMoney, jsonLd, nextData, gate, detect, evaluate, first };
  root.PS5Detect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
