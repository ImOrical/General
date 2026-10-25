// Runs on every store page. Does nothing unless the background worker says this
// tab is a watcher (report stock), a checkout tab (click through to the order) or
// a keeper tab (make sure we're signed in). In iframes it only fills the CVV.
(function () {
  if (window.__ps5Loaded) return;
  window.__ps5Loaded = true;

  const C = PS5Config;
  const D = PS5Detect;
  const F = PS5Flow;
  const FL = PS5Fast;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  if (window.top !== window) {
    frameCvv();
    return;
  }

  let ctx = null;
  let role = 'none';
  let lastLiveState = null;
  let fetching = false;
  let lanes = [];

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'fetchCheck' && role === 'watch') fetchCheck();
  });

  init();

  async function init() {
    const reply = await send({ type: 'hello', url: location.href });
    if (!reply || reply.role === 'none') return;
    ctx = reply;
    role = reply.role;
    if (role === 'watch') watch();
    else if (role === 'checkout') checkout();
    else if (role === 'keeper') keeper();
  }

  // ---------------------------------------------------------------- watching

  async function watch() {
    setupLanes();
    // Give client-side rendering a moment to settle on a definite answer.
    let res;
    for (let i = 0; i < 20; i++) {
      res = D.detect(document, ctx.store, location.href, { live: true });
      if (res.state !== 'unknown') break;
      await sleep(400);
    }
    res.lane = currentLane().kind;
    await report(res);

    // Catch the page flipping to in stock on its own (some stores poll stock in-page).
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending || role !== 'watch') return;
      pending = true;
      setTimeout(async () => {
        pending = false;
        if (role !== 'watch') return;
        const r = D.detect(document, ctx.store, location.href, { live: true });
        if (r.state !== lastLiveState) await report(r);
      }, 500);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'class', 'aria-disabled', 'data-button-state'],
    });
  }

  async function report(res) {
    lastLiveState = res.state;
    const reply = await send({ type: 'status', result: res });
    if (reply && reply.go && role === 'watch') {
      ctx = reply.ctx;
      role = 'checkout';
      checkout();
    }
  }

  // Quick-check lanes, cheapest first:
  //   learned:  the stock request this page itself just made (a few KB of JSON)
  //   template: a known small stock endpoint for this store (Best Buy, Amazon)
  //   html:     the whole product page, read without rendering
  // A lane that keeps returning nothing useful is skipped for the rest of this page.
  function setupLanes() {
    lanes = [];
    const useApi = !(ctx.settings && ctx.settings.distrustApi);
    if (useApi) {
      const learn = (url) => {
        if (!FL.isLearnable(ctx.store, location.href, url)) return;
        const lane = lanes.find((l) => l.kind === 'learned');
        if (lane) lane.url = url;
        else lanes.unshift({ kind: 'learned', url, format: 'json', strikes: 0 });
      };
      try {
        for (const e of performance.getEntriesByType('resource')) learn(e.name);
        new PerformanceObserver((list) => list.getEntries().forEach((e) => learn(e.name))).observe({ type: 'resource' });
      } catch (_) {
        // No resource timing here; the other lanes still work.
      }
      const t = FL.templateUrl(ctx.store, location.href);
      if (t) lanes.push({ kind: 'template', url: t, format: (ctx.store.fast && ctx.store.fast.templateFormat) || 'json', strikes: 0 });
    }
    lanes.push({ kind: 'html', url: null, format: 'html', strikes: 0 });
  }

  function currentLane() {
    return lanes.find((l) => l.strikes < 3) || lanes[lanes.length - 1];
  }

  async function fetchCheck() {
    if (fetching) return;
    fetching = true;
    const lane = currentLane();
    const t0 = performance.now();
    const base = { at: Date.now(), url: location.href, lane: lane.kind, source: lane.kind === 'html' ? 'fetch' : 'api' };
    try {
      let url = lane.url || location.href;
      if (lane.kind === 'html' && ctx.settings && ctx.settings.cacheBust) {
        const u = new URL(url);
        u.searchParams.set('_ps5', Date.now().toString(36));
        url = u.toString();
      }
      const sameOrigin = new URL(url).origin === location.origin;
      const resp = await fetch(url, { credentials: sameOrigin ? 'include' : 'omit', cache: 'no-store', redirect: 'follow' });
      const rtt = Math.round(performance.now() - t0);
      if (resp.status === 403 || resp.status === 429 || resp.status === 503) {
        lane.strikes++;
        await send({ type: 'status', result: { ...base, state: 'blocked', httpStatus: resp.status, rtt } });
        return;
      }
      let res;
      if (lane.format === 'json') {
        let json = null;
        try {
          json = await resp.json();
        } catch (_) {
          // Not JSON after all; counts as a miss for this lane.
        }
        res = { ...base, ...(json ? FL.parseStockJson(json) : { state: 'unknown' }) };
      } else {
        const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
        res =
          lane.format === 'aod'
            ? { ...base, ...FL.parseAod(doc, ctx.store, ctx.settings) }
            : { ...D.detect(doc, ctx.store, resp.url || location.href, { live: false }), lane: 'html' };
      }
      lane.strikes = res.state === 'unknown' ? lane.strikes + 1 : 0;
      res.rtt = rtt;
      await send({ type: 'status', result: res });
    } catch (e) {
      lane.strikes++;
      await send({ type: 'status', result: { ...base, state: 'error', error: String(e), rtt: Math.round(performance.now() - t0) } });
    } finally {
      fetching = false;
    }
  }

  // ---------------------------------------------------------------- checkout

  function event(name, data = {}) {
    return send({ type: 'checkout', event: name, url: location.href, ...data });
  }

  const askedFor = new Set();
  function needsYou(reason) {
    if (askedFor.has(reason)) return null;
    askedFor.add(reason);
    return event('needs_you', { reason });
  }

  function click(el) {
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (_) {
      // Not all elements support scrollIntoView options; the click still works.
    }
    el.click();
  }

  // Sets an input the way a typing user would, so React/Vue forms notice.
  function setInputValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    el.focus();
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  // After Add to Cart: 'added' once the page confirms it, 'wait' if the button
  // went into a "Please Wait" queue state (don't leave the page), else 'timeout'.
  async function afterClick(step) {
    const added = step.after.waitFor ? C.re(step.after.waitFor) : null;
    const end = Date.now() + (step.after.timeoutMs || 4000);
    while (Date.now() < end) {
      if (added && added.test(D.textOf(document.body, 30000))) return 'added';
      if (step.waitText) {
        const f = D.findClickable(document, step.click, { live: true });
        if (!f.el && f.disabled && C.re(step.waitText).test(D.labelOf(f.disabled))) return 'wait';
      }
      await sleep(200);
    }
    return 'timeout';
  }

  // ---------------------------------------------------------------- CVV and sign-in

  const filledCvv = new WeakSet();
  let cvvProblem = null;

  // Fills any empty CVV box on the page. Returns false if one is there but we
  // have no CVV to give it (vault locked or nothing saved).
  async function fillCvv() {
    const fields = F.emptyCvvFields(document, ctx.store, { live: true }).filter((el) => !filledCvv.has(el));
    if (!fields.length) return true;
    const reply = await send({ type: 'cvv' });
    if (!reply || !reply.cvv) {
      cvvProblem = (reply && reply.error) || 'no CVV saved';
      return false;
    }
    for (const el of fields) {
      setInputValue(el, reply.cvv);
      filledCvv.add(el);
    }
    await sleep(300);
    return true;
  }

  function framesWithEmptyCvv() {
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        const d = frame.contentDocument;
        if (d && d.body && F.emptyCvvFields(d, null, { live: true }).length) return true;
      } catch (_) {
        // Cross-origin frame: can't look inside, its own script handles it.
      }
    }
    return false;
  }

  // Card boxes embedded in an iframe. The background only hands over the CVV
  // when the top page is one of our checkout tabs.
  function frameCvv() {
    const filled = new WeakSet();
    let busy = false;
    let refusedUntil = 0;
    const tryFill = async () => {
      if (busy || Date.now() < refusedUntil) return;
      const fields = F.emptyCvvFields(document, null, { live: true }).filter((el) => !filled.has(el));
      if (!fields.length) return;
      busy = true;
      const reply = await send({ type: 'cvv' });
      busy = false;
      if (!reply || !reply.cvv) {
        refusedUntil = Date.now() + 10000;
        return;
      }
      for (const el of fields) {
        setInputValue(el, reply.cvv);
        filled.add(el);
      }
    };
    let timer = null;
    const observer = new MutationObserver(() => {
      if (!timer) timer = setTimeout(() => ((timer = null), tryFill()), 400);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    setTimeout(() => observer.disconnect(), 10 * 60000);
    tryFill();
  }

  const signinTries = { email: 0, password: 0 };
  let signinSince = 0;

  // Signs in with the login saved in the vault. Returns 'submitted', 'wait'
  // (form not rendered yet) or { reason } when a person has to do it.
  async function autoSignIn(step) {
    signinSince = signinSince || Date.now();
    const act = F.signInAction(document, ctx.store, { live: true });
    if (act.kind === 'otp') return { reason: `${step.needsUser}: enter the verification code the store just sent you` };
    if (act.kind === 'none') {
      if (Date.now() - signinSince < 8000) return 'wait';
      return { reason: `${step.needsUser} (couldn't find the sign-in form)` };
    }
    if (signinTries[act.kind] >= 2) return { reason: `${step.needsUser} (sign-in isn't going through; check the saved password)` };
    const creds = await send({ type: 'signin', kind: act.kind });
    if (!creds || creds.error) return { reason: `${step.needsUser} (${(creds && creds.error) || 'no saved login'})` };
    if (!act.submit) return { reason: `${step.needsUser} (couldn't find the Sign in button)` };
    if (act.email && !act.email.value) setInputValue(act.email, creds.email);
    if (act.password) setInputValue(act.password, creds.password);
    if (act.remember && !act.remember.checked) act.remember.click();
    signinTries[act.kind]++;
    await sleep(300);
    click(act.submit);
    return 'submitted';
  }

  // ---------------------------------------------------------------- session keeper

  // Opened every few hours on each store's account page: if we've been signed
  // out, sign back in now rather than in the middle of a drop.
  async function keeper() {
    const report = (result, extra = {}) => send({ type: 'keeper', result, url: location.href, ...extra });
    await sleep(1500);
    let clickedLink = false;
    for (let i = 0; i < 60; i++) {
      const url = location.href;
      if (D.gate(document, url) === 'blocked') return report('needs_you', { reason: 'a CAPTCHA is showing on the sign-in check' });
      const step = F.stepsFor(ctx.store, url).find((s) => s.signin);
      if (step) {
        const r = await autoSignIn(step);
        if (r === 'submitted' || r === 'wait') {
          await sleep(r === 'wait' ? 500 : 2500);
          continue;
        }
        return report('needs_you', { reason: r.reason });
      }
      const link = F.signedOutLink(document, ctx.store, { live: true });
      if (link && clickedLink) return report('needs_you', { reason: "still signed out after clicking Sign in" });
      if (link) {
        clickedLink = true;
        click(link);
        await sleep(3000);
        continue;
      }
      if (i < 2) {
        await sleep(500);
        continue;
      }
      return report('ok');
    }
    return report('needs_you', { reason: 'the sign-in check timed out' });
  }

  async function waitClickable(spec, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const f = D.findClickable(document, spec, { live: true });
      if (f.el) return f.el;
      await sleep(250);
    }
    return null;
  }

  // Waits out a CAPTCHA or queue page without touching it. If it clears without a
  // navigation (CAPTCHA solved in place), returns so the checkout loop can continue.
  async function waitOutGate(kind) {
    if (kind === 'blocked') await needsYou('A CAPTCHA / bot check is showing. Solve it and checkout will continue.');
    else await event('queue', {});
    while (D.gate(document, location.href) === kind) await sleep(1000);
  }

  async function checkout() {
    role = 'checkout';
    const store = ctx.store;
    const cc = ctx.checkout;
    const clicks = {};
    let idleSince = Date.now();
    let lastBeat = 0;
    let emptySince = 0;
    await sleep(250);

    for (let iter = 0; iter < 400; iter++) {
      const url = location.href;
      if (F.isConfirmation(document, url, store)) return event('confirmed', { url });

      const gate = D.gate(document, url);
      if (gate) {
        await waitOutGate(gate);
        idleSince = Date.now();
        continue;
      }
      await fillCvv();

      const steps = F.stepsFor(store, url);
      // Carts often render "empty" for a moment before items load, so require 4s of it.
      if (/cart/i.test(url) && steps.some((s) => s.id === 'cart') && F.isEmptyCart(document)) {
        emptySince = emptySince || Date.now();
        if (Date.now() - emptySince > 4000) return event('failed', { reason: 'cart is empty (add to cart did not go through)' });
        await sleep(300);
        continue;
      }
      emptySince = 0;
      if (!steps.length) {
        if (cc.viaDirect && Date.now() - idleSince > 5000) return fallBackToCart('unrecognized page');
        if (Date.now() - idleSince > 15000) return needsYou(`Checkout reached a page I don't recognize: ${url}`);
        await sleep(500);
        continue;
      }
      const signIn = steps.find((s) => s.signin);
      if (signIn) {
        const r = await autoSignIn(signIn);
        if (r === 'submitted') {
          await event('step', { step: 'signin' });
          idleSince = Date.now();
          await sleep(2000);
        } else if (r === 'wait') {
          await sleep(500);
        } else {
          await needsYou(r.reason);
          await sleep(1000);
        }
        continue;
      }

      let step = null;
      let found = null;
      for (const s of steps) {
        if (!s.click) continue;
        const f = D.findClickable(document, s.click, { live: true });
        if (f.el || f.disabled) {
          step = s;
          found = f;
          break;
        }
      }
      if (!step) {
        if (cc.viaDirect && Date.now() - idleSince > 5000) return fallBackToCart('no checkout button');
        if (Date.now() - idleSince > 20000) return needsYou(`Stuck on "${steps[0].id}": couldn't find the button`);
        await sleep(400);
        continue;
      }

      if (step.final) return finalStep(step, found);

      if (step.id === 'pdp' && !cc.practice && found.el) {
        // Re-check right before adding to cart: price, seller and condition can change.
        const ev = D.evaluate(D.detect(document, store, url, { live: true }), cc);
        if (!ev.ok) return event('failed', { reason: 'listing no longer passes checks: ' + ev.reasons.join('; ') });
      }

      if (!found.el) {
        const label = D.labelOf(found.disabled);
        const waiting = step.waitText && C.re(step.waitText).test(label);
        if (step.id === 'pdp' && !waiting && Date.now() - idleSince > 5000) {
          return event('failed', { reason: `sold out before add to cart (button says "${label || 'disabled'}")` });
        }
        if (waiting) {
          // Best Buy-style "Please Wait" button: it re-enables when it's your turn.
          // Keep telling the background we're alive so it doesn't call this a stall.
          if (Date.now() - lastBeat > 10000) {
            lastBeat = Date.now();
            await event('step', { step: `${step.id} (waiting: ${label})` });
          }
          idleSince = Date.now();
        } else if (Date.now() - idleSince > 20000) {
          return needsYou(`"${step.id}" button is disabled (${label || 'no label'})`);
        }
        await sleep(300);
        continue;
      }

      clicks[step.id] = (clicks[step.id] || 0) + 1;
      if (clicks[step.id] > 4) return needsYou(`Clicked "${step.id}" 4 times and nothing happened`);
      await event('step', { step: step.id });
      click(found.el);
      idleSince = Date.now();

      if (step.after && step.after.navigate) {
        if ((await afterClick(step)) === 'wait') continue;
        const nav = step.after.navigate;
        if (nav === 'checkout' && store.checkoutUrl) {
          // Skip the cart page (one less page load). If the store bounces us,
          // the cart step or the fallback below takes over.
          await event('step', { step: 'straight to checkout', direct: true });
          location.assign(store.checkoutUrl);
        } else {
          location.assign(nav === 'cart' || nav === 'checkout' ? store.checkout.cartUrl : nav);
        }
        return null;
      }
      await sleep(1500);
    }
    return needsYou('Checkout timed out on this page');
  }

  // Going straight to checkout didn't land on a usable page: take the long way.
  async function fallBackToCart(why) {
    await event('step', { step: `checkout shortcut failed (${why}), going via cart`, direct: false });
    location.assign(ctx.store.checkout.cartUrl);
    return null;
  }

  async function finalStep(step, found) {
    const store = ctx.store;
    const cc = ctx.checkout;
    const guard = F.finalGuard(document, store, cc);
    await event('guard', { subtotal: guard.subtotal, problems: guard.problems });
    if (!guard.ok && cc.viaDirect) return fallBackToCart('order summary not ready');
    if (!guard.ok) return needsYou('Stopped before Place Order: ' + guard.problems.join('; '));

    // A CVV box inside an iframe is filled by that frame's own script; give it a moment.
    for (let i = 0; i < 12 && framesWithEmptyCvv(); i++) await sleep(250);
    const cvvOk = (await fillCvv()) && !framesWithEmptyCvv();
    if (!cvvOk && cc.mode === 'armed' && !cc.practice) {
      return needsYou(`Card security code (CVV) needed and ${cvvProblem || 'it could not be filled in'}. Type it and press Place Order, or save it in the vault on the dashboard.`);
    }

    const btn = found.el || (await waitClickable(step.click, 8000));
    if (!btn) return needsYou('Place Order button stayed disabled');

    if (cc.practice || cc.mode !== 'armed') {
      return event('dry_run_final', { subtotal: guard.subtotal, button: D.labelOf(btn) });
    }

    const lock = await send({ type: 'checkout', event: 'request_lock', url: location.href });
    if (!lock || !lock.granted) return event('failed', { reason: 'not placing the order: ' + ((lock && lock.reason) || 'no answer from the extension') });

    const before = D.textOf(document.body, 40000);
    click(btn);
    await event('placed_click', { subtotal: guard.subtotal });

    // If the page navigates, the next page's script reports the result.
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (F.isConfirmation(document, location.href, store)) return event('confirmed', { url: location.href, subtotal: guard.subtotal });
      const after = D.textOf(document.body, 40000);
      if (F.newFailures(before, after)) {
        const m = after.match(new RegExp('[^.]{0,80}(' + C.MATCH.failure + ')[^.]{0,80}', 'i'));
        return event('place_failed', { reason: m ? m[0].trim() : 'store showed an error' });
      }
    }
    return event('uncertain', { subtotal: guard.subtotal });
  }
})();
