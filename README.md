# PS5 Pro Restock Buyer

A Chrome extension that watches PlayStation Direct, Best Buy, Target, Walmart, Amazon and GameStop for a **new PS5 Pro at list price, sold by the store itself**. When one shows up, it checks out automatically using your own signed-in accounts and saved card, then pings your phone.

It runs in your normal Chrome on your PC: your accounts, your home internet, one console.

## What it will and won't buy

It places an order only if **all** of these are true. Each one is checked on the product page and again on the final review page:

- The page title and order summary say **PS5 Pro**.
- The price, and the order subtotal on the review page, are **at or under your max** (default **$899.99**). A second console or any other item in the cart pushes the subtotal over, so it stops.
- It's **new**, not refurbished, renewed, restored, pre-owned, used or open-box.
- It's **sold by the store**. Marketplace and third-party sellers on Amazon, Walmart, Best Buy and Target are ignored, which is where the $1,200+ listings are.
- **Nothing has been bought yet.** Only one store can press Place Order at a time, and after a confirmed order everything stops and it switches back to monitor-only.

If something looks off, for example in stock but the seller can't be confirmed, it **alerts you instead of buying**.

## When it stops and asks for you

It won't solve CAPTCHAs, skip queues, use proxies or run extra accounts. When it hits one of these, your phone gets an urgent alert and the PC sounds a siren and brings the tab to the front:

- A **CAPTCHA** or "press and hold" check. Solve it and checkout picks up where it left off.
- A **sign-in** page. Stay signed in to every store so this doesn't happen mid-drop.
- A **CVV** prompt, unless you've saved your CVV on the dashboard.
- A **waiting room** (Queue-it, Best Buy's "Please Wait"). It holds your place without refreshing, and continues on its own when it's your turn.

## Setup on your PC (about 20 minutes)

1. **Get the files.** On GitHub open this repo, switch to the branch `claude/ps5-pro-purchase-plan-8n2ika`, click **Code → Download ZIP**, and unzip it somewhere permanent (for example `Documents\ps5-buyer`).
2. **Install the extension.** In Chrome go to `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose the `extension` folder. Pin the blue ▶ icon and click it to open the dashboard.
3. **Phone alerts.** Install the free **ntfy** app (iPhone or Android). On the dashboard click **Generate** next to *ntfy topic*, then in the app tap **+** and subscribe to that exact topic. Click **Save settings**, then **Send test alert**, and check your phone.
   - Optional: [Pushover](https://pushover.net) ($5 one time). Its emergency alerts keep ringing until you acknowledge them, which helps for 3 a.m. drops. Paste your user key and an app token.
4. **Sign in to every store in this Chrome profile.** For each one: tick *keep me signed in*, save your **shipping address** and **card**, and **empty the cart**.
5. **Check the product links.**
   - **Amazon:** paste the PS5 Pro listing that says *Ships from Amazon.com, Sold by Amazon.com*.
   - **Walmart:** the built-in link is a best guess. Open it and confirm it says *Sold and shipped by Walmart.com*. If it doesn't, paste the right one.
   - The others are built in. Leave the box blank to use them.
6. **Practice every store.** Click **Practice** on each row and paste a link to any cheap in-stock item at that store, such as a $5 cable. It adds the item to the cart and goes all the way to the Place Order screen, then stops. You should get *"Practice passed at …"*. **Empty that cart afterwards.** If a practice fails, see [When a store changes its page](#when-a-store-changes-its-page).
7. **Choose a mode and click Start.**
   - **Monitor:** alerts only.
   - **Dry run:** adds to cart and goes to Place Order, then alerts you to click it yourself. Run this for a day first.
   - **Armed:** buys automatically.
8. **Keep the PC awake.** Set the power plan to never sleep and keep it plugged in. Leave Chrome open with the watcher window. Turn off Chrome's Energy Saver (Settings → Performance). The watcher tabs are already protected from Memory Saver.

Keep **HotStock** running on your phone as a second safety net.

## How fast it is

Each store gets a light check every **4 seconds**: the page HTML is fetched quietly and read without rendering. Every **40 seconds** the page fully reloads. Timing is randomized so the checks don't look robotic. If a quick check sees stock, the page reloads straight away to confirm, then checkout starts. The page also watches itself, so if the store flips the button to *Add to Cart* while the page is open, it reacts within half a second.

In the end-to-end test against local fake stores, it went from **restock to placed order in 2.0 seconds**. On real sites expect a few more seconds, because each page load takes 1–3 seconds over the internet.

Checking faster than every 3 seconds per store usually gets you rate-limited. If a store pushes back, the extension slows down that store on its own and tells you.

## Modes and alerts

| Event | Phone | PC |
|---|---|---|
| In stock and passes every check | Urgent | Siren + tab comes to the front |
| Needs you (CAPTCHA, CVV, sign-in, a check failed) | Urgent | Siren + tab comes to the front |
| Waiting room opened (usually means a drop is starting) | Urgent | Siren |
| Order placed | Urgent | Siren |
| Blocked or slowed by a store, a watcher went quiet | High | Notification |
| "Still running" heartbeat every 6 hours | Low | Notification |

## When a store changes its page

Stores redesign their pages, and when they do, a button or price can stop being found. Practice mode will tell you. Then:

1. Open **Advanced: store overrides** on the dashboard.
2. Add the fix as JSON. It's merged over the built-in definitions in [`extension/lib/config.js`](extension/lib/config.js). For example:
   ```json
   { "bestbuy": { "checkout": { "steps": [ ... ] }, "detect": { "priceSelectors": [".new-price-class"] } } }
   ```
   Lists replace the built-in list, and objects merge into it.
3. Run Practice again.

To fix these quickly, run [Claude Code](https://claude.ai/code) on the PC in this folder with the store page open in Chrome, and ask it to update the selectors.

## Tests

```bash
npm install
npm test           # unit tests: page reading, price/seller/condition rules, checkout guards
npm run test:e2e   # loads the real extension in Chromium against fake stores (needs Playwright + port 443)
```

The end-to-end suite covers buying on a restock, two stores dropping at once (exactly one order), ignoring a $1,299 third-party listing, monitor mode, dry run, Best Buy's "Please Wait" queue, CVV entry, a CAPTCHA at checkout, and refusing a cart with extra items.

The fake stores copy the markup the extension expects, so they prove the engine works, not that the real sites still match. That's what Practice mode is for.

## Good to know

- **Price and dates (Oct 2026):** US list price is $899.99, after Sony's April 2026 increase. GTA 6 launches **Nov 19**, which will push demand up. Black Friday is **Nov 27**. Last year Sony took $100 off; if that happens again, lower the max price to match.
- **Store rules:** most stores' terms prohibit automated purchasing, so an order could be cancelled or an account restricted. This tool keeps that risk low: one account, one console, normal pacing, and it stops for every CAPTCHA.
- **CVV:** if you save it, it's stored only in this Chrome profile's extension storage and is only typed into the store's own CVV box. Leave it blank and you'll be asked instead.
