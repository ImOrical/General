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

  // ---------------------------------------------------------------- sign-in and CVV

  const CVV_SELECTORS = [
    'input[autocomplete="cc-csc"]',
    'input[name*="cvv" i]',
    'input[id*="cvv" i]',
    'input[name*="cvc" i]',
    'input[id*="cvc" i]',
    'input[name*="securityCode" i]',
    'input[id*="securityCode" i]',
    'input[name*="security_code" i]',
  ];
  const EMAIL_SELECTORS = [
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[name="username"]',
    'input[id="username"]',
    'input[name*="signinId" i]',
  ];
  const PASSWORD_SELECTORS = ['input[type="password"]'];
  const OTP_SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="verificationCode" i]',
    'input[name="code"]',
  ];
  const REMEMBER_SELECTORS = [
    'input[type="checkbox"][name*="remember" i]',
    'input[type="checkbox"][id*="remember" i]',
    'input[type="checkbox"][name*="keep" i]',
    'input[type="checkbox"][id*="keep" i]',
    'input[type="checkbox"][name*="staySigned" i]',
  ];
  const SUBMIT_TEXT = '^(sign ?in|log ?in|continue|next|submit|sign in securely|sign in with (a |your )?password|use (a |your )?password)$';

  function usable(el, live) {
    if (!el || el.type === 'hidden' || el.disabled || el.readOnly) return false;
    return !live || D.isVisible(el);
  }

  function pick(root, selectors, live) {
    for (const sel of selectors) {
      let els = [];
      try {
        els = root.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const el of els) if (usable(el, live)) return el;
    }
    return null;
  }

  // CVV boxes on this page that are still empty.
  function emptyCvvFields(doc, store, opts = {}) {
    const fromSteps = ((store && store.checkout && store.checkout.steps) || []).flatMap((s) => s.cvv || []);
    const out = [];
    for (const sel of [...new Set([...fromSteps, ...CVV_SELECTORS])]) {
      let els = [];
      try {
        els = doc.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const el of els) if (usable(el, opts.live) && !el.value && !out.includes(el)) out.push(el);
    }
    return out;
  }

  // What a sign-in page wants next: 'otp' (a code we can't know), 'password',
  // 'email' (email-first flows like Amazon's), or 'none' (not loaded yet).
  function signInAction(doc, store, opts = {}) {
    const si = (store && store.signin) || {};
    const live = !!opts.live;
    const text = D.textOf(doc.body, 20000);
    const otp = pick(doc, OTP_SELECTORS, live) || (C.re(C.MATCH.otp).test(text) ? pick(doc, ['input[type="tel"]', 'input[inputmode="numeric"]', 'input[type="number"]', 'input[type="text"]'], live) : null);
    if (otp) return { kind: 'otp', otp };
    const password = pick(doc, [...(si.password || []), ...PASSWORD_SELECTORS], live);
    const email = pick(doc, [...(si.email || []), ...EMAIL_SELECTORS], live);
    if (!password && !email) return { kind: 'none' };
    const form = (password || email).closest('form');
    const spec = { selectors: si.submit || [], text: SUBMIT_TEXT };
    const submit = (form && D.findClickable(form, spec, { live }).el) || D.findClickable(doc, spec, { live }).el;
    // Styled checkboxes are often visually hidden, so don't require visibility.
    const remember = pick(form || doc, REMEMBER_SELECTORS, false);
    return { kind: password ? 'password' : 'email', email, password, submit, remember };
  }

  // A visible "Sign in" link on an ordinary page means the session has expired.
  function signedOutLink(doc, store, opts = {}) {
    const si = (store && store.signin) || {};
    return D.findClickable(doc, { selectors: si.signedOutSelectors || [], text: si.signedOutText || C.MATCH.signedOut }, { live: !!opts.live }).el;
  }

  const api = { stepsFor, findSubtotal, isConfirmation, newFailures, isEmptyCart, productInOrder, finalGuard, emptyCvvFields, signInAction, signedOutLink, CVV_SELECTORS };
  root.PS5Flow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
