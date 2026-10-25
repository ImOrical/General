# PS5 Pro at MSRP: Purchase Plan

Status: **plan only, nothing built yet.** Waiting on the decisions at the bottom.

## Where things stand (as of Oct 25, 2026)

- **US list price: $899.99.** Sony raised it on April 2, 2026 (it launched at $699.99 in Nov 2024).
- **Stock is short.** Restocks sell out within minutes. Over the past week brief restocks were reported at Amazon and PlayStation Direct, and Best Buy sold out on Oct 23.
- **Scalper and resale prices run $1,200–$1,500.** Walmart open-box units are listed at $1,399 and GameStop *used* units at about $1,400.
- **GTA 6 comes out Nov 19, 2026**, so demand will rise over the next month.
- **Black Friday is Nov 27, Cyber Monday Nov 30.** Last year Sony took $100 off every PS5 model. If that happens again the Pro would be about $799.99, but **Sony hasn't announced anything**.
- About 70–80% of restocks happen at five stores: **PlayStation Direct, Amazon, Best Buy, Target and Walmart.** PlayStation Direct restocks most consistently and always at MSRP.

## Is there a better way than "fully automated"?

**Yes. Automate everything except the final checkout click.** A bot that checks out with no one watching is the wrong tool here:

1. **It mostly won't work.** These stores use bot protection (Akamai, HUMAN/PerimeterX, Queue-it on PlayStation Direct, CAPTCHAs, and card verification codes sent by text). A homemade checkout bot loses to these more often than it wins, and even paid "sneaker bots" struggle.
2. **Orders get cancelled and accounts get banned.** Every one of these stores bans automated buying in its terms. Orders flagged as bot purchases are often cancelled after you've paid. PlayStation Direct purchases are tied to your **PSN account**, the same account you'd use on the console.
3. **Security.** Your store passwords and card details would have to sit in a script on a computer that's always on.

What wins restocks in practice: **you hear about it instantly, and checkout is already 90% done.** With saved payment details in the store's app, a person completes checkout in 20–40 seconds, which is fast enough.

## The plan

### Phase 0: Setup with no code (≈20 min, do this today)
- [ ] Create accounts at **PlayStation Direct, Amazon, Best Buy, Target and Walmart**. On each one, save your shipping address and card, and turn on two-factor sign-in.
- [ ] Install each store's app on your phone and stay signed in. App checkout is the fastest.
- [ ] Follow the free alert sources that already exist, with notifications on: **Wario64** and **Matt Swider / The Shortcut** on X, plus a tracker such as **NowInStock**, **HotStock**, **StockInformer** or **Trackalacker**.
- [ ] Optional: paid memberships (Walmart+, Target Circle 360, My Best Buy Plus/Total). Some past console restocks were members-only.

Phase 0 alone gets many people a console. Phase 1 makes it faster and more reliable.

### Phase 1: Restock monitor with phone alerts (what I'd build)
A small Python program that runs on **your** always-on computer:

| Part | What it does |
|---|---|
| **Checkers** (one per store) | Load the PS5 Pro product page every 60–120 seconds, with random spacing between checks. Report **in stock / price / who's selling it**. Uses Playwright, an automated headless browser, for pages that need JavaScript to load. |
| **Filter** | Alerts only when **price ≤ $899.99** (you set the limit) **and the store itself is the seller**. Third-party marketplace sellers on Amazon and Walmart are ignored, because that's where the scalpers are. |
| **Notifier** | Sends an urgent push notification to your phone with a **direct product or cart link**. Options: **ntfy** (free) or **Pushover** ($5 one time; its emergency alerts repeat until you acknowledge them, which helps for 3 a.m. restocks). |
| **Optional, on your computer** | Opens the product page in your already signed-in browser, so you only have to confirm. |
| **Config file** | Product links, price limit, how often to check, quiet hours, alert channel. |
| **Health check** | A daily "still running" message, plus an alert if a checker keeps failing (for example, because a store redesigned its page). |

**Where it runs:** a home computer, Mac or Raspberry Pi on your home internet.
- *GitHub Actions is out.* It can only check every 5 minutes at best, the runs start late, and stores block its data-center addresses.
- *A cloud server is a poor second.* Stores often block data-center internet addresses too.
- *This cloud session can't run it.* It's temporary and can't reach the store sites. I'll write and unit-test the code here, and you'll do the first live run at home.

**Upkeep:** stores change their pages now and then, so expect to fix a checker occasionally. The health check tells you when one breaks.

### Fallbacks (if you don't have one by a date you choose)
- **Black Friday window (about Nov 20–30):** keep the monitor running, and consider lowering the price limit to $799.99 if Sony announces a discount.
- **Refurbished:** Back Market lists refurbished PS5 Pros starting around $639, below MSRP and with no hunting. Also check whether PlayStation Direct is selling Sony-certified refurbished units.
- **Bundles:** GTA 6 bundles count only if the total is at or below MSRP plus the game's own price.

### What I won't build
A bot that checks out with no one watching, gets past CAPTCHAs or queues, or runs several accounts at once. The reasons are in the section above.

## Decisions I need from you
1. **Where will it run?** (Windows PC, Mac, Linux machine or Raspberry Pi, and is it on 24/7?)
2. **Alert channel:** ntfy (free), Pushover ($5) or a Discord webhook?
3. **Stores:** all five above, or a subset? Any that aren't US?
4. **Price limit:** $899.99, or something else? Should it watch for a Black Friday price?
5. **Is refurbished acceptable** as a fallback?

## Sources
- [The Shortcut: PS5 Pro restock, Best Buy sold out (Oct 2026)](https://www.theshortcut.com/p/ps5-pro-restock-best-buy-october-2026)
- [The Shortcut: Restock tips to avoid scalper prices](https://www.theshortcut.com/p/ps5-pro-restock-tips-how-to-avoid-paying-scalper-prices-for-a-playstation-5-pro)
- [Tom's Guide: PS5 Pro restock updates](https://www.tomsguide.com/gaming/playstation/ps5-pro-restocks-latest-updates)
- [Softonic: GameStop lists used PS5 Pro for $1,400](https://en.softonic.com/articles/ps5-pro-remains-sold-out-gamestop-lists-used-consoles-for-1400)
- [Trackalacker: PS5 Pro price and where to buy](https://www.trackalacker.com/articles/news/find-ps5-pro-in-stock)
- [TYPA: PS5 Pro restock tracker](https://www.typa.app/blog/ps5-pro-restock-tracker-where-to-buy-a-ps5-pro-in-stock)
- [Notebookcheck: PS5 Pro back in stock on PlayStation Direct](https://www.notebookcheck.net/PS5-Pro-is-back-in-stock-on-the-official-PlayStation-Store-but-stock-may-not-last-long.1387703.0.html)
- [Autonomous: PS5 Black Friday 2026 expectations](https://www.autonomous.ai/ourblog/ps5-black-friday-deals)
- [TechBuzz: Sony cut $100 off every PS5 model last Black Friday](https://www.techbuzz.ai/articles/sony-drops-ps5-prices-100-across-all-models-for-black-friday)
- [Back Market: PS5 Black Friday deals (refurbished)](https://www.backmarket.com/en-us/c/black-friday/ps5-black-friday-deals)
- [GTABoom: Buying a PS5 Pro for GTA 6](https://www.gtaboom.com/time-is-running-out-if-youre-planning-to-buy-a-ps5-pro-for-gta-6-02c8)
