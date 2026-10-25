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

## Sign-in, CVV and CAPTCHAs

**Sign-in is automatic.** Your store logins live in an encrypted vault on the dashboard. If a store signs you out, the extension signs back in by itself, including email-first flows like Amazon's and Target's, and ticks *keep me signed in*. It also checks every store's account page every 3 hours while watching, so an expired session gets fixed hours before a drop instead of in the middle of one. It stops after 3 wrong passwords in an hour so it can't lock your account.

**CVV is automatic.** Save it in the vault and it's typed in wherever a store asks, on any checkout step, including card boxes embedded in the page.

**The vault** is encrypted with AES-256 under a passphrase only you know, and stored only in this Chrome profile. Unlocking keeps the decrypted copy in memory until Chrome closes, so after a restart you unlock it once. The dashboard and the start alert both warn you if it's locked.

**What still needs you:**

- **One-time codes** a store texts or emails you. It can't read your texts, so it alerts you.
- **CAPTCHAs** and "press and hold" checks. This extension doesn't solve or get around them: they're the stores' anti-bot protection, and defeating them is circumventing site security. What it does instead:
  - **Makes them rare.** One real browser, your signed-in sessions kept fresh, randomized pacing, and automatic backoff when a store pushes back. Those are the things that make stores show fewer challenges.
  - **Makes them quick to solve from anywhere.** You get an urgent push, a siren on the PC, the tab is brought to the front, and the alert repeats every minute (up to 5 times) until it's handled. Set *"Needs you" alerts open* to Chrome Remote Desktop (see setup) and tapping the alert on your phone opens your PC, so you can solve it in about 10 seconds. Checkout continues by itself as soon as you're through.
- **Waiting rooms** (Queue-it, Best Buy's "Please Wait") need nothing from you. It holds your place without refreshing, and carries on when it's your turn.

## Setup on your PC (about 20 minutes)

1. **Get the files.** On GitHub open this repo, switch to the branch `claude/ps5-pro-purchase-plan-8n2ika`, click **Code → Download ZIP**, and unzip it somewhere permanent (for example `Documents\ps5-buyer`).
2. **Install the extension.** In Chrome go to `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose the `extension` folder. Pin the blue ▶ icon and click it to open the dashboard.
3. **Phone alerts.** Install the free **ntfy** app (iPhone or Android). On the dashboard click **Generate** next to *ntfy topic*, then in the app tap **+** and subscribe to that exact topic. Click **Save settings**, then **Send test alert**, and check your phone.
   - Optional: [Pushover](https://pushover.net) ($5 one time). Its emergency alerts keep ringing until you acknowledge them, which helps for 3 a.m. drops. Paste your user key and an app token.
4. **Sign in to every store in this Chrome profile.** For each one: tick *keep me signed in*, save your **shipping address** and **card**, and **empty the cart**.
5. **Fill in the vault.** Under *Logins & card (encrypted)*, enter each store's email and password and your card's CVV, choose a passphrase, and click **Encrypt & save**. Then click **Check sign-ins now**: the *Signed in* column should say *Yes* for every store. If a store sends a one-time code during that check, enter it once in the tab that stays open. Most stores then remember this browser.
6. **Remote access for CAPTCHAs (recommended).** Install [Chrome Remote Desktop](https://remotedesktop.google.com/access) on the PC and the Chrome Remote Desktop app on your phone. Then set *"Needs you" alerts open* to `https://remotedesktop.google.com/access`.
7. **Check the product links.** To watch several listings at one store (for example a second PS5 Pro SKU), paste them all into that store's box, separated by spaces.
   - **Amazon:** paste the PS5 Pro listing that says *Ships from Amazon.com, Sold by Amazon.com*.
   - **Walmart:** the built-in link is a best guess. Open it and confirm it says *Sold and shipped by Walmart.com*. If it doesn't, paste the right one.
   - The others are built in. Leave the box blank to use them.
8. **Practice every store.** Click **Practice** on each row and paste a link to any cheap in-stock item at that store, such as a $5 cable. It adds the item to the cart and goes all the way to the Place Order screen, then stops. You should get *"Practice passed at …"*. **Empty that cart afterwards.** If a practice fails, see [When a store changes its page](#when-a-store-changes-its-page).
9. **Choose a mode and click Start.**
   - **Monitor:** alerts only.
   - **Dry run:** adds to cart and goes to Place Order, then alerts you to click it yourself. Run this for a day first.
   - **Armed:** buys automatically.
10. **Keep the PC awake.** Set the power plan to never sleep and keep it plugged in. Leave Chrome open with the watcher window. Turn off Chrome's Energy Saver (Settings → Performance). The watcher tabs are already protected from Memory Saver. If Chrome restarts (a Windows update, say), watching starts again on its own. Unlock the vault when you see the alert.

Keep **HotStock** running on your phone as a second safety net.

## How fast it is

Four layers, fastest first.

1. **Outside alerts** (fastest, if you set them up). Restock services like HotStock run many monitors at once and often know first. Forward their alerts to the *Listen on ntfy topic* box and the extension checks that store immediately, then buys if it's real. In testing, outside alert to placed order took **1.0 second**. Setup is under [Outside alerts](#outside-alerts-optional-but-fastest).
2. **The store's own stock request.** Product pages ask the store "is this in stock?" with a tiny request, a few kilobytes instead of a whole page. The extension spots that request while the page loads and repeats it every **2.5 seconds**. Best Buy's stock lookup and Amazon's seller list are built in. The *Speed* column shows **API** when a store uses this.
3. **Page quick checks** when no stock request was found: the page HTML every **4 seconds**, read without rendering. A full reload happens every **40 seconds**, and the open page reacts within half a second if the store flips its button.
4. **Hot mode.** After any sign of a drop (a queue opening, stock showing anywhere, an outside alert), every interval is halved for 15 minutes, because restocks often hit several stores at once. During *warm hours* (default weekdays 7 a.m.–noon Eastern, a guess you can edit) intervals are three-quarters. You can also press **Go hot 30 min** yourself, for example when PlayStation announces a drop.

Once stock is confirmed, checkout goes **straight to the checkout page**, skipping the cart, and falls back to the cart if a store insists. Timing is randomized throughout. If a store turns away the quick checks, that listing is watched by reloading the page every 20 seconds instead, and the dashboard shows "Reload 20s" rather than calling the store blocked. "Bot check: solve it" only appears when the page itself shows a CAPTCHA.

**Measured on the fake stores** (1-second checks): restock to alert in 1.8 seconds using the stock lookup alone. Restock to placed order in 1.8 seconds. Outside alert to placed order in 1.0 second. On real sites add network time and 1–3 seconds per page load.

**Limits.** Checks never go faster than once a second per listing. If a store pushes back, that store slows down on its own and you're told. If a quick check says "in stock" three times and the page disagrees, that quick check is ignored for 30 minutes. Going faster would take pools of proxy addresses or many accounts, which this deliberately doesn't do.

### Outside alerts (optional, but fastest)

1. On the dashboard, click **Generate** next to *Listen on ntfy topic*, then **Save settings**. Use a different topic from your phone-alert topic.
2. Forward restock alerts to `https://ntfy.sh/<that topic>`:
   - **Android + HotStock:** install **MacroDroid** (free). Create a macro with trigger *Notification received*, app *HotStock*. Add the action *HTTP request*, method **POST**, URL `https://ntfy.sh/<topic>`, body `[notification_title] [notification_text]`.
   - **iPhone:** iOS doesn't let one app act on another app's notifications, so HotStock can't be forwarded automatically. Anything else that can send a web request works, such as a Discord bot, IFTTT or Zapier.
3. Test it: `curl -d "PS5 Pro in stock at Best Buy" https://ntfy.sh/<topic>` while watching. The Activity log should say *Outside alert, checking Best Buy now*.

An alert never buys anything by itself. It only makes the extension check right away. Alerts that don't mention a PS5 Pro are ignored, unless you tick the box that turns that filter off.

## Modes and alerts

| Event | Phone | PC |
|---|---|---|
| In stock and passes every check | Urgent | Siren + tab comes to the front |
| Needs you (CAPTCHA, one-time code, a check failed) | Urgent, repeats every minute up to 5 times | Siren + tab comes to the front |
| Signed out and couldn't sign back in (sign-in check) | High | Notification, tab left open |
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
npm test           # unit tests: page reading, price/seller/condition rules, checkout guards, sign-in forms, vault, stock requests, hot hours, outside alerts
npm run test:e2e   # loads the real extension in Chromium against fake stores (needs Playwright + port 443)
```

The end-to-end suite covers:

- buying on a restock
- two stores dropping at once (exactly one order)
- ignoring a $1,299 third-party listing
- monitor mode and dry run
- Best Buy's "Please Wait" queue
- CVV entry, including inside an iframe
- a CAPTCHA at checkout
- refusing a cart with extra items
- automatic sign-in (one-page and email-first)
- a one-time code
- a locked vault
- the sign-in check signing back in ahead of a drop
- the vault's save, lock and unlock on the dashboard
- catching a restock from Best Buy's stock lookup without a page reload
- learning Target's own stock request (and ignoring pickup-only stock and a recommended product)
- an outside alert causing an immediate check and purchase
- two listings at one store
- the checkout shortcut, including Walmart bouncing it to the cart

The fake stores copy the markup the extension expects, so they prove the engine works, not that the real sites still match. That's what Practice mode is for.

## Good to know

- **Price and dates (Oct 2026):** US list price is $899.99, after Sony's April 2026 increase. GTA 6 launches **Nov 19**, which will push demand up. Black Friday is **Nov 27**. Last year Sony took $100 off; if that happens again, lower the max price to match.
- **Store rules:** most stores' terms prohibit automated purchasing, so an order could be cancelled or an account restricted. This tool keeps that risk low: one account, one console, normal pacing, and it stops for every CAPTCHA.
- **Your logins and CVV** are only ever typed into the store's own pages, and only in a tab the extension opened for checkout or a sign-in check. Ordinary browsing never gets them. Lock the vault on the dashboard whenever you like.
