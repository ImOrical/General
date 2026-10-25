// Checkout helpers: which step a page is on, the order subtotal, and whether an
// order went through. Pure functions over a Document so they can be unit tested.
(function (root) {
  const C = root.PS5Config || (typeof require !== 'undefined' ? require('./config.js') : null);
  const D = root.PS5Detect || (typeof require !== 'undefined' ? require('./detect.js') : null);

  const SUBTOTAL_LABEL = /^(order )?(subtotal|items?\s*(\(\d+\))?\s*(sub)?total|items?\s*(\(\d+\))?\s*:|item\(s\)\s*(sub)?total|merchandise\s*(sub)?total|product\s*subtotal)/i;
  const SUBTOTAL_ANYWHERE = new RegExp(SUBTOTAL_LABEL.source.slice(1), 'i');
  const MONEY = /\$\s*([\d,]+\.\d{2})/;

  function stepsFor(store, url) {
    return ((store.checkout && store.checkout.steps) || []).filter((s) => {
      try {
        return C.re(s.url).test(url);
      } catch (_) {
        return false;
      }
    });
  }

  function ownText(el) {
    let t = '';
    for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) t += c.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  }

  // The items subtotal on a cart or review page. Tries the store's own selectors,
  // then looks for a "Subtotal"/"Items:" label and the first dollar amount after it.
  function findSubtotal(doc, store) {
    const selectors = (store.checkout && store.checkout.subtotalSelectors) || [];
    for (const sel of selectors) {
      const el = D.first(doc, [sel]);
      const p = el && D.parseMoney(D.textOf(el, 200));
      if (p != null) return p;
    }
    const els = doc.body ? doc.body.querySelectorAll('span, div, td, th, dt, dd, p, label, li, h2, h3, h4, strong, b') : [];
    for (const el of els) {
      const own = ownText(el);
      if (!own || own.length > 60 || !SUBTOTAL_LABEL.test(own)) continue;
      let node = el;
      for (let up = 0; up < 4 && node; up++, node = node.parentElement) {
        const t = D.textOf(node, 600);
        const idx = t.search(SUBTOTAL_ANYWHERE);
        const m = (idx >= 0 ? t.slice(idx) : t).match(MONEY);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
      }
    }
    return null;
  }

  function isConfirmation(doc, url, store) {
    const conf = (store.checkout && store.checkout.confirm) || {};
    if (conf.url && C.re(conf.url).test(url)) return true;
    if (!conf.text) return false;
    return C.re(conf.text).test(D.textOf(doc.body, 20000));
  }

  function countMatches(text, src) {
    const m = text.match(new RegExp(src, 'gi'));
    return m ? m.length : 0;
  }

  // Failure messages that weren't on the page before we clicked. Checkout pages
  // carry policy text like "if an item is out of stock...", so we compare counts.
  function newFailures(beforeText, afterText) {
    return countMatches(afterText, C.MATCH.failure) > countMatches(beforeText, C.MATCH.failure);
  }

  function isEmptyCart(doc) {
    return C.re(C.MATCH.emptyCart).test(D.textOf(doc.body, 20000));
  }

  function productInOrder(doc) {
    return C.re(C.MATCH.productTitle).test(D.textOf(doc.body, 60000));
  }

  // Everything the final step checks before it may press Place Order.
  function finalGuard(doc, store, ctx) {
    const subtotal = findSubtotal(doc, store);
    const problems = [];
    if (!ctx.practice && !productInOrder(doc)) problems.push("couldn't find \"PS5 Pro\" in the order summary");
    if (subtotal == null) problems.push("couldn't read the order subtotal");
    else if (!ctx.practice && subtotal > ctx.priceCap + 0.005) problems.push(`subtotal $${subtotal.toFixed(2)} is over your $${ctx.priceCap} cap (other items in the cart?)`);
    else if (!ctx.practice && subtotal < ctx.minPrice) problems.push(`subtotal $${subtotal.toFixed(2)} is under $${ctx.minPrice}, which doesn't look like one PS5 Pro`);
    return { ok: problems.length === 0, subtotal, problems };
  }

  const api = { stepsFor, findSubtotal, isConfirmation, newFailures, isEmptyCart, productInOrder, finalGuard };
  root.PS5Flow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
