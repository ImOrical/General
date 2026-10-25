// Store definitions and default settings. Shared by the background worker,
// content scripts, the dashboard and the Node tests.
//
// Selectors and text patterns are best guesses at how each store's pages look.
// Stores change their markup, so run Practice mode on every store before arming,
// and fix anything that breaks with the "Store overrides" box on the dashboard
// (it's deep-merged over these defaults, no code changes needed).
(function (root) {
  const PRODUCT_TITLE = '(playstation\\s*®?\\s*5|ps5)\\s*pro\\b';
  const NOT_NEW = '\\b(refurb\\w*|renewed|restored|pre-?owned|used|open[- ]?box)\\b';
  const OOS = 'sold out|out of stock|currently unavailable|temporarily unavailable|coming soon|notify me|check back|get in-stock alert|not available';
  // Kept strict on purpose: review pages often say things like "order confirmation
  // will be emailed", and a false match would mark the hunt as finished.
  const CONFIRM = 'thank you for your order|thanks for your order|your order (has been placed|is confirmed|was placed)|order placed, thank';
  const FAILURE = 'no longer available|out of stock|sold out|unable to (process|place|complete)|could not (process|place)|payment (was )?declined|something went wrong|please try again';

  const STORES = {
    psdirect: {
      name: 'PlayStation Direct',
      hosts: ['direct.playstation.com'],
      checkoutUrl: 'https://direct.playstation.com/en-us/checkout',
      // Quick checks: the page's own stock request, learned while the page loads.
      fast: { learn: ['api\\.direct\\.playstation\\.com/.*(productList|stock|inventory)', 'direct\\.playstation\\.com/.*/(stock|availability)'] },
      // Signed-in check for the session keeper. PS Direct has no simple account
      // page, so the cart is used and a visible "Sign In" link means signed out.
      accountUrl: 'https://direct.playstation.com/en-us/cart',
      signin: { email: ['#signin-entrance-input-signinId'], password: ['#signin-password-input-password'], submit: ['#signin-entrance-button', '#signin-password-button'] },
      productUrl: 'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb',
      firstPartySeller: null, // Sony sells everything on PS Direct
      sellerMissingMeansFirstParty: true,
      detect: {
        scope: ['.productHero-desktop', '.productHero-info', 'main'],
        buy: { selectors: ['button.add-to-cart:not(.hide)', 'button[data-product-action="add-to-cart"]'], text: '^add to cart$' },
        priceSelectors: ['.productHero-desktop .product-price', '.product-price', '[data-price]'],
        sellerSelectors: [],
        titleSelectors: ['h1'],
        conditionSelectors: [],
      },
      checkout: {
        cartUrl: 'https://direct.playstation.com/en-us/cart',
        steps: [
          { id: 'signin', url: 'my\\.account\\.sony\\.com|/signin|/login', signin: true, needsUser: 'Sign in to your PlayStation account' },
          { id: 'pdp', url: 'direct\\.playstation\\.com/[a-z-]+/buy-', click: { selectors: ['button.add-to-cart:not(.hide)'], text: '^add to cart$', scope: ['.productHero-desktop', 'main'] }, waitText: 'please wait|adding', after: { navigate: 'checkout', waitFor: 'added to (your )?cart|view cart|cart \\(1\\)', timeoutMs: 4000 } },
          { id: 'cart', url: 'direct\\.playstation\\.com/[a-z-]+/cart', click: { selectors: ['button.checkout-btn', 'a.checkout-btn'], text: '^(proceed to )?check ?out$' } },
          { id: 'place', url: 'direct\\.playstation\\.com/[a-z-]+/checkout', final: true, click: { selectors: ['button.place-order', 'button[name="placeOrder"]'], text: '^place (your )?order$' }, cvv: ['input[name*="cvv" i]', 'input[id*="cvv" i]', 'input[name*="securityCode" i]'] },
          { id: 'continue', url: 'direct\\.playstation\\.com/[a-z-]+/checkout', click: { selectors: [], text: '^(continue|next|continue to (payment|review))$' } },
        ],
        confirm: { url: 'order-confirmation|/confirmation|/thank-?you', text: CONFIRM },
      },
    },

    bestbuy: {
      name: 'Best Buy',
      hosts: ['www.bestbuy.com'],
      checkoutUrl: 'https://www.bestbuy.com/checkout/r/fast-track',
      fast: {
        learn: ['/button-state/api/', '/fulfillment/[^?]*(availability|options)', '/api/[^?]*availability'],
        idFrom: 'skuId=(\\d+)|/sku/(\\d+)|/(\\d{6,9})\\.p',
        template: 'https://www.bestbuy.com/button-state/api/v5/button-state?skus={id}&context=pdp&source=buttonView',
      },
      accountUrl: 'https://www.bestbuy.com/site/customer/myaccount',
      signin: { email: ['#fld-e'], password: ['#fld-p1'], submit: ['button.cia-form__controls__submit'] },
      productUrl: 'https://www.bestbuy.com/site/6601524.p?skuId=6601524',
      firstPartySeller: 'best\\s*buy',
      // Best Buy's marketplace listings show a "Sold by" line; its own listings usually don't.
      sellerMissingMeansFirstParty: true,
      detect: {
        scope: ['.fulfillment-add-to-cart-button', '[data-testid="fulfillment-add-to-cart-button"]', '.pdp-main', 'main'],
        buy: { selectors: ['button.add-to-cart-button', 'button[data-button-state="ADD_TO_CART"]', 'button[data-test-id="add-to-cart"]'], text: '^add to cart$' },
        priceSelectors: ['[data-testid="customer-price"] span', '.priceView-customer-price span[aria-hidden="true"]', '.priceView-hero-price span'],
        sellerSelectors: ['[data-testid="marketplace-seller"]', '.marketplace-seller', '[data-testid="seller-info"]'],
        titleSelectors: ['h1'],
        conditionSelectors: ['[data-testid="condition-selected"]'],
      },
      checkout: {
        cartUrl: 'https://www.bestbuy.com/cart',
        steps: [
          { id: 'signin', url: 'bestbuy\\.com/identity/', signin: true, needsUser: 'Sign in to Best Buy' },
          { id: 'pdp', url: 'bestbuy\\.com/(site|product)/', click: { selectors: ['button.add-to-cart-button', 'button[data-test-id="add-to-cart"]'], text: '^add to cart$', scope: ['.fulfillment-add-to-cart-button', '[data-testid="fulfillment-add-to-cart-button"]', 'main'] }, waitText: 'please wait', after: { navigate: 'checkout', waitFor: 'added to cart|go to cart|cart \\(1\\)', timeoutMs: 4000 } },
          { id: 'cart', url: 'bestbuy\\.com/cart', click: { selectors: ['.checkout-buttons__checkout button', 'button[data-track="Checkout - Top"]'], text: '^check ?out$' } },
          { id: 'place', url: 'bestbuy\\.com/checkout', final: true, click: { selectors: ['.button__fast-track', 'button[data-track="Place your Order - Contact Card"]'], text: '^place (your )?order$' }, cvv: ['#cvv', 'input[name="cvv"]', '#credit-card-cvv', 'input[id*="cvv" i]'] },
          { id: 'continue', url: 'bestbuy\\.com/checkout', click: { selectors: [], text: '^continue to (payment information|schedule|review)' } },
        ],
        confirm: { url: 'bestbuy\\.com/checkout/.*(thank|confirm)', text: CONFIRM },
      },
    },

    target: {
      name: 'Target',
      hosts: ['www.target.com'],
      checkoutUrl: 'https://www.target.com/checkout',
      fast: { learn: ['redsky_aggregations/v1/web/[a-z_]*fulfillment'], idFrom: '/A-(\\d+)' },
      accountUrl: 'https://www.target.com/account',
      signin: { email: ['#username'], password: ['#password'], submit: ['#login'] },
      productUrl: 'https://www.target.com/p/playstation-5-pro-console/-/A-93620188',
      firstPartySeller: '^\\s*target\\s*$|sold (and|&) shipped by target\\b',
      // Target Plus partner listings say "Sold and shipped by <partner>"; Target's own don't.
      sellerMissingMeansFirstParty: true,
      detect: {
        scope: ['[data-test="flexible-fulfillment"]', '[data-test="product-details-container"]', 'main'],
        buy: { selectors: ['button[data-test="shipItButton"]', 'button[data-test="shippingButton"]', 'button[id^="addToCartButton"]'], text: '^(add to cart|ship it)$' },
        priceSelectors: ['[data-test="product-price"]'],
        sellerSelectors: ['[data-test="targetPlusExtraInfoSection"]', '[data-test="sold-by"]'],
        titleSelectors: ['h1[data-test="product-title"]', 'h1'],
        conditionSelectors: [],
      },
      checkout: {
        cartUrl: 'https://www.target.com/cart',
        steps: [
          { id: 'signin', url: 'target\\.com/(login|account/signin)|login\\.target\\.com', signin: true, needsUser: 'Sign in to Target' },
          { id: 'pdp', url: 'target\\.com/p/', click: { selectors: ['button[data-test="shipItButton"]', 'button[data-test="shippingButton"]', 'button[id^="addToCartButton"]'], text: '^(add to cart|ship it)$', scope: ['[data-test="flexible-fulfillment"]', 'main'] }, after: { navigate: 'checkout', waitFor: 'added to cart|view cart', timeoutMs: 4000 } },
          { id: 'cart', url: 'target\\.com/cart', click: { selectors: ['button[data-test="checkout-button"]'], text: '^(check ?out|i\'m ready to check ?out)$' } },
          { id: 'place', url: 'target\\.com/checkout', final: true, click: { selectors: ['button[data-test="placeOrderButton"]'], text: '^place (your )?order$' }, cvv: ['#creditCardInput-cvv', 'input[name="cvv"]', 'input[id*="cvv" i]'] },
          { id: 'continue', url: 'target\\.com/checkout', click: { selectors: ['button[data-test="save-and-continue-button"]'], text: '^save (and|&) continue$' } },
        ],
        confirm: { url: 'target\\.com/(order-confirmation|co-thankyou)', text: CONFIRM },
      },
    },

    walmart: {
      name: 'Walmart',
      hosts: ['www.walmart.com'],
      checkoutUrl: 'https://www.walmart.com/checkout',
      fast: { learn: ['/orchestra/(pdp|home)/graphql/[^?]*(ip|item|product)'], idFrom: '/ip/(?:[^/]+/)?(\\d+)' },
      accountUrl: 'https://www.walmart.com/account',
      signin: { email: [], password: [], submit: [] },
      // Check this is the "Sold and shipped by Walmart.com" listing before relying on it.
      productUrl: 'https://www.walmart.com/ip/Sony-PlayStation-5-Pro-Console-PS5-Pro/18235967161',
      // "Fulfilled by Walmart" doesn't count: that's a third-party seller using Walmart shipping.
      firstPartySeller: 'sold (and shipped )?by\\s*walmart(\\.com)?\\b|^\\s*walmart(\\.com)?\\s*$',
      // Walmart item pages can show a third-party seller in the buy box, so require proof.
      sellerMissingMeansFirstParty: false,
      extractors: ['nextData'],
      detect: {
        scope: ['[data-testid="add-to-cart-section"]', '[data-testid="flex-container"]', 'main'],
        buy: { selectors: ['button[data-automation-id="atc"]', '[data-dca-name="ItemBuyBoxAddToCartButton"]'], text: '^add to cart$' },
        priceSelectors: ['[itemprop="price"]', '[data-testid="price-wrap"] [itemprop="price"]'],
        sellerSelectors: ['[data-testid="product-seller-info"]', 'a[data-testid="seller-name-link"]', '[data-testid="sold-and-shipped-by"]'],
        titleSelectors: ['h1#main-title', 'h1'],
        conditionSelectors: ['[data-testid="condition-label"]'],
      },
      checkout: {
        cartUrl: 'https://www.walmart.com/cart',
        steps: [
          { id: 'signin', url: '(identity\\.)?walmart\\.com/account/login', signin: true, needsUser: 'Sign in to Walmart' },
          { id: 'pdp', url: 'walmart\\.com/ip/', click: { selectors: ['button[data-automation-id="atc"]', '[data-dca-name="ItemBuyBoxAddToCartButton"]'], text: '^add to cart$', scope: ['[data-testid="add-to-cart-section"]', 'main'] }, after: { navigate: 'checkout', waitFor: 'added to cart|view cart|cart \\(1\\)', timeoutMs: 4000 } },
          { id: 'cart', url: 'walmart\\.com/cart', click: { selectors: ['button[data-automation-id="checkout"]'], text: '^continue to checkout$' } },
          { id: 'place', url: 'walmart\\.com/checkout', final: true, click: { selectors: ['button[data-automation-id="place-order-button"]'], text: '^place order$' }, cvv: ['input[name="cvv"]', 'input[id*="cvv" i]'] },
          { id: 'continue', url: 'walmart\\.com/checkout', click: { selectors: [], text: '^(continue|review order)$' } },
        ],
        confirm: { url: 'walmart\\.com/(checkout/)?(thankyou|order-confirmation)', text: CONFIRM },
      },
    },

    amazon: {
      name: 'Amazon',
      hosts: ['www.amazon.com'],
      checkoutUrl: 'https://www.amazon.com/gp/buy/spc/handlers/display.html?hasWorkingJavascript=1',
      fast: {
        idFrom: '/dp/([A-Z0-9]{10})|/gp/product/([A-Z0-9]{10})',
        // The "other sellers" panel: small, and lists Amazon's own offer even when
        // a third-party seller holds the buy box.
        template: 'https://www.amazon.com/gp/product/ajax/aodAjaxMain/?asin={id}&pc=dp&experienceId=aodAjaxMain&isAod=1&experience=aod&ref=dp_aod_NEW_mbc',
        templateFormat: 'aod',
      },
      accountUrl: 'https://www.amazon.com/gp/css/order-history',
      signin: { email: ['#ap_email', '#ap_email_login'], password: ['#ap_password'], submit: ['#signInSubmit', 'input#continue', '#continue'] },
      // Paste the listing that says "Ships from Amazon.com, Sold by Amazon.com".
      productUrl: '',
      firstPartySeller: 'sold by\\s*:?\\s*amazon(\\.com)?\\b(?!\\s*(resale|warehouse|renewed))',
      sellerMissingMeansFirstParty: false,
      detect: {
        scope: ['#desktop_buybox', '#buybox', '#rightCol', '#centerCol'],
        buy: { selectors: ['#add-to-cart-button', '#buy-now-button'], text: '^(add to cart|buy now)$' },
        priceSelectors: ['#corePrice_feature_div .a-offscreen', '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen', '.priceToPay .a-offscreen', '#price_inside_buybox'],
        sellerSelectors: ['#tabular-buybox', '#merchantInfoFeature_feature_div', '#merchant-info', '[offer-display-feature-name="desktop-merchant-info"]'],
        titleSelectors: ['#productTitle', 'h1'],
        conditionSelectors: ['#usedBuySection', '#renewedBuyBoxSection'],
        inviteText: 'request (an )?invit(e|ation)',
      },
      checkout: {
        cartUrl: 'https://www.amazon.com/gp/cart/view.html',
        steps: [
          { id: 'signin', url: 'amazon\\.com/ap/(signin|mfa|cvf)', signin: true, needsUser: 'Sign in to Amazon' },
          { id: 'pdp', url: 'amazon\\.com/(.*/)?(dp|gp/product)/', click: { selectors: ['#add-to-cart-button'], text: '^add to cart$', scope: ['#desktop_buybox', '#buybox', '#rightCol'] }, after: { navigate: 'checkout', waitFor: 'added to cart|proceed to checkout|no thanks', timeoutMs: 4000 } },
          { id: 'cart', url: 'amazon\\.com/(gp/cart|cart)', click: { selectors: ['input[name="proceedToRetailCheckout"]', '#sc-buy-box-ptc-button input'], text: '^proceed to checkout' } },
          { id: 'place', url: 'amazon\\.com/(gp/buy|checkout)', final: true, click: { selectors: ['#submitOrderButtonId input', 'input[name="placeYourOrder1"]', '#placeOrder', '#bottomSubmitOrderButtonId input'], text: '^place your order$' }, cvv: [] },
          { id: 'continue', url: 'amazon\\.com/(gp/buy|checkout)', click: { selectors: ['input[data-testid="Address_selectShipToThisAddress"]', '#shipToThisAddressButton input'], text: '^(use this (address|payment method)|deliver to this address|continue)$' } },
        ],
        confirm: { url: 'amazon\\.com/(gp/buy/thankyou|checkout/.*thankyou)', text: 'order placed, thank you|thank you, your order has been placed|' + CONFIRM },
      },
    },

    gamestop: {
      name: 'GameStop',
      hosts: ['www.gamestop.com'],
      checkoutUrl: 'https://www.gamestop.com/checkout/',
      fast: { learn: ['Product-Variation', '/availability'], idFrom: '/(\\d{6,9})\\.html' },
      accountUrl: 'https://www.gamestop.com/account/',
      signin: { email: ['#login-form-email'], password: ['#login-form-password'], submit: [] },
      productUrl: 'https://www.gamestop.com/consoles-hardware/playstation-5/consoles/products/sony-playstation-5-pro-console/20015604.html?condition=New',
      firstPartySeller: null,
      sellerMissingMeansFirstParty: true,
      detect: {
        scope: ['.primary-details-row', '.add-to-cart-buttons', 'main'],
        buy: { selectors: ['button.add-to-cart', 'button[data-buttontext="Add to Cart"]'], text: '^add to cart$' },
        priceSelectors: ['.primary-details-row .actual-price', '.price .actual-price', '[data-testid="price"]'],
        sellerSelectors: [],
        titleSelectors: ['h1.product-name', 'h1'],
        // The selected condition button. If it says Pre-Owned we won't buy.
        conditionSelectors: ['.condition-selector .selected', 'button[data-attr-value][aria-pressed="true"]', '[data-testid="condition-selected"]'],
      },
      checkout: {
        cartUrl: 'https://www.gamestop.com/cart/',
        steps: [
          { id: 'signin', url: 'gamestop\\.com/(login|account/login)', signin: true, needsUser: 'Sign in to GameStop' },
          { id: 'pdp', url: 'gamestop\\.com/.*/products/', click: { selectors: ['button.add-to-cart'], text: '^add to cart$', scope: ['.primary-details-row', '.add-to-cart-buttons', 'main'] }, after: { navigate: 'checkout', waitFor: 'added to cart|view cart', timeoutMs: 4000 } },
          { id: 'cart', url: 'gamestop\\.com/cart', click: { selectors: ['a.checkout-btn', 'button.checkout-btn'], text: '^(proceed to )?check ?out$' } },
          { id: 'place', url: 'gamestop\\.com/(checkout|spcheckout)', final: true, click: { selectors: ['button.place-order', 'button[value="place-order"]'], text: '^place order$' }, cvv: ['input[name*="securityCode" i]', 'input#saved-payment-security-code', 'input[id*="cvv" i]'] },
          { id: 'continue', url: 'gamestop\\.com/(checkout|spcheckout)', click: { selectors: [], text: '^(continue|next: payment|next: review)' } },
        ],
        confirm: { url: 'order-confirmation|/confirmation|thank-?you', text: CONFIRM },
      },
    },
  };

  const DEFAULT_SETTINGS = {
    // monitor (alerts only) | dryrun (goes to Place Order, never clicks it) | armed (buys)
    mode: 'monitor',
    priceCap: 899.99,
    // Below this, the "PS5 Pro" we matched is probably an accessory or a pricing glitch:
    // alert, but don't auto-buy.
    minPrice: 600,
    // How it finds stock:
    //   'alerts' - restock alerts (Discord, ntfy) do the spotting; the stores are
    //              only loaded every few minutes as a safety net, and checked
    //              quickly for a short burst after an alert. Fewest CAPTCHAs.
    //   'both'   - alerts plus its own frequent checks below. Faster on its own,
    //              but the stores see far more traffic and show more CAPTCHAs.
    detection: 'alerts',
    safetyReloadSec: 300,
    burstReloadSec: 8,
    burstMinutes: 2,
    // Discord channel links to watch for restock posts (one per line), and
    // whether to open product links found in those posts.
    discord: { channels: '', openLinks: true },
    // Seconds between checks per listing: the store's small stock request
    // (when one was found) and the whole product page.
    apiIntervalSec: 2.5,
    fetchIntervalSec: 4,
    reloadIntervalSec: 40,
    // Hot: right after any sign of a drop. Warm: during the hot windows below.
    // Intervals are multiplied by these (never under 1 second).
    hotFactor: 0.5,
    warmFactor: 0.75,
    hotMinutes: 15,
    // Eastern time. A starting guess at when restocks cluster; edit freely.
    hotWindows: 'Mon-Fri 07:00-12:00',
    // Outside restock alerts (e.g. HotStock forwarded from your phone) posted to
    // this ntfy topic make the extension check that store immediately.
    trigger: { ntfyTopic: '', anyProduct: false },
    jitterPct: 30,
    // When a store refuses the quick checks, that listing is watched by full
    // page reloads at this pace instead (before hot/warm speed-ups).
    reloadOnlySec: 20,
    // Re-open the watcher automatically when Chrome starts.
    autoStart: true,
    // How often to check every store still has you signed in (0 = never).
    keeperHours: 3,
    // Legacy plain-text CVV; the encrypted vault replaces it.
    cvv: '',
    alerts: {
      ntfyServer: 'https://ntfy.sh',
      ntfyTopic: '',
      pushoverUser: '',
      pushoverToken: '',
      discordWebhook: '',
      // Where tapping a "needs you" alert goes, e.g. Chrome Remote Desktop.
      needsYouLink: '',
      desktop: true,
      siren: true,
    },
    stores: {
      psdirect: { enabled: true, productUrl: '' },
      bestbuy: { enabled: true, productUrl: '' },
      target: { enabled: true, productUrl: '' },
      walmart: { enabled: true, productUrl: '' },
      amazon: { enabled: true, productUrl: '' },
      gamestop: { enabled: true, productUrl: '' },
    },
    overrides: {},
  };

  const MATCH = {
    productTitle: PRODUCT_TITLE,
    notNew: NOT_NEW,
    oos: OOS,
    failure: FAILURE,
    confirm: CONFIRM,
    // Only trusted on short pages (bot walls and queue pages are small), so a stray
    // word in a full product page doesn't trip them.
    blocked: 'robot check|robot or human|are you a (human|robot)|verify (that )?you are (a )?human|press (&|and) hold|unusual traffic|(type|enter) the characters you see|request blocked|pardon our interruption|you don\'t have permission to access',
    queue: 'you are now in line|you\'re in line|waiting room|your estimated wait time|number in line|queue-it',
    emptyCart: 'your (shopping )?(cart|bag) is empty|cart is empty|no items in (your )?cart',
    otp: '(enter|type) (the|your|a) (\\d-digit )?(verification|security|one[- ]time|sign[- ]in) (code|passcode)|we (just )?(sent|texted|emailed) (a|you a|your) (\\d-digit )?(code|passcode)|one[- ]time (pass)?code|two[- ]step verification|enter otp',
    signedOut: '^(sign ?in|log ?in|sign in or create account|sign in / create account|account sign in)$',
  };

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Objects merge, everything else (arrays included) replaces.
  function deepMerge(base, over) {
    if (!isPlainObject(over)) return over === undefined ? clone(base) : clone(over);
    const out = isPlainObject(base) ? clone(base) : {};
    for (const [k, v] of Object.entries(over)) {
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : clone(v);
    }
    return out;
  }

  function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
  }

  function resolveSettings(saved) {
    return deepMerge(DEFAULT_SETTINGS, saved || {});
  }

  // The listings to watch at a store: the links you entered (space- or
  // comma-separated, so one store can have several listings), else the built-in one.
  function watchUrls(id, settings) {
    const typed = String(((settings.stores || {})[id] || {}).productUrl || '')
      .split(/[\s,]+/)
      .filter((u) => /^https?:\/\//i.test(u));
    if (typed.length) return typed;
    return STORES[id] && STORES[id].productUrl ? [STORES[id].productUrl] : [];
  }

  // The store definition with the user's overrides and product URL applied.
  function resolveStore(id, settings) {
    const base = STORES[id];
    if (!base) return null;
    const merged = deepMerge(base, (settings.overrides || {})[id] || {});
    merged.productUrl = watchUrls(id, settings)[0] || '';
    merged.id = id;
    return merged;
  }

  function storeForHost(hostname) {
    for (const [id, s] of Object.entries(STORES)) {
      if (s.hosts.some((h) => hostname === h || hostname.endsWith('.' + h))) return id;
    }
    return null;
  }

  function re(src, flags) {
    return new RegExp(src, flags === undefined ? 'i' : flags);
  }

  const api = { STORES, DEFAULT_SETTINGS, MATCH, deepMerge, resolveSettings, resolveStore, watchUrls, storeForHost, re };
  root.PS5Config = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
