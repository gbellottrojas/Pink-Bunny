# Pink Bunny — Offline Mode

This folder is a **separate, standalone app** (not opened through Google's
script.google.com page) that works with **zero internet connection** —
searching/adding products, updating quantities, and checking out all work
offline. When the device gets a signal again, it syncs everything to your
Google Sheet automatically.

Why a separate app: Apps Script web apps are served from Google's sandboxed
iframe, which blocks the two things offline support needs (service workers
and installable behavior). So this piece lives outside that sandbox, and
your Apps Script project becomes a small sync API it talks to when online.

## 1. Redeploy the updated Code.gs

The Code.gs you already have now includes two new endpoints (`doGet` with
`?api=products`, and `doPost` for syncing) that match your current sheet
structure — Cost/Charge in USD, Sale/Deduction types, and the exchange
rate. In the Apps Script editor:

1. **Deploy → Manage deployments → your deployment → Edit (pencil) → New version → Deploy.**
2. Make sure access is set to **"Anyone"** (not "Anyone within [org]") or the
   offline app won't be able to reach it from outside Google.
3. Copy the **Web app URL** (ends in `/exec`) — you'll paste it into the app's
   Settings in step 3.
4. First time only: Google will ask you to re-authorize (this version doesn't
   need any new permissions beyond what you already granted).

## 2. Host these files somewhere over HTTPS

Offline support (service workers) only works over HTTPS or `localhost` —
never over `file://`. The easiest free option is **GitHub Pages**:

1. Create a new GitHub repo, upload everything in this `offline-app` folder
   to it (keep the `icons/` subfolder).
2. Repo **Settings → Pages → Deploy from a branch → main → / (root) → Save**.
3. GitHub gives you a URL like `https://yourname.github.io/pink-bunny/`.

(Netlify Drop, Firebase Hosting, or Vercel work the same way if you prefer
one of those instead.)

## 3. First-time setup on the device (needs internet, once)

This step **must** be done while online — it's what makes offline use
possible afterward:

1. Open the hosted URL from step 2 on the phone/tablet/laptop you'll use at
   the stall.
2. Tap **Settings** at the top, paste in the Web App URL from step 1, tap
   **Save URL**, then tap **Sync now** once. This downloads your full
   product catalog into the device and caches the app itself for offline use.
3. **Install it as an app** so it's easy to open with no signal:
   - **Android (Chrome):** menu (⋮) → "Install app" / "Add to Home screen."
   - **iPhone/iPad (Safari):** Share icon → "Add to Home Screen."
   - **Desktop (Chrome/Edge):** install icon (⊕) in the address bar.

Do this once per device before heading somewhere without signal.

## 4. Using it offline

Everything works the same as the Google Sheets version, no connection needed:

- **Inventory tab:** search the dropdown, update quantity, or add a brand
  new product (including Cost/Charge in USD) — all saved to the device
  instantly.
- **Cashier tab:** pick a pricing mode, add items to the cart as a **Sale**
  or a **Deduction** (Sponsor / Gift / Collaboration — still leaves
  inventory, charges Bs 0), and check out. Stock decrements locally right
  away.
- **Download PDF receipt** works fully offline (generated on the device),
  and shows Deductions in their own section like the online version.
- **Reports tab** computes the same profit report as the Sheets version —
  Profit = Price Sold − (Cost + Charge) × exchange rate — from the sales
  stored on this device, so it works offline too and always includes
  anything not yet synced. Download it as a PDF the same way.
- **Send via WhatsApp** needs a connection at the moment you tap it (that's
  a WhatsApp limitation, not this app's) — it's grayed out while offline.
  Once you're back online you can open the last sale and send it.

The status bar at the top always shows **Online/Offline** and how many
changes are still waiting to sync.

## 5. Syncing back up

As soon as the device gets signal again, it **syncs automatically** (and
you can also tap **Sync now** any time). This pushes every offline sale,
new product, and quantity update to your Google Sheet — including the
Sale/Deduction type and Cost/Charge snapshot — and pulls back the shared,
up-to-date catalog and exchange rate.

A couple of things worth knowing:
- **The Reports tab only sees sales made on that specific device.** It reads
  from a local sales log, not from your Google Sheet, so if you run this
  on two phones, each one's profit report only reflects its own sales —
  it won't include what the other phone rang up. For a combined total
  across devices, use the Reports tab in the Google Sheets version instead
  (that one reads the actual Sales sheet, which every device syncs into).
- **Product codes** created offline are random (`ST######`) so collisions
  between two devices are extremely unlikely — but if it ever happens, the
  sync automatically renames the newer one and updates it on the device.
- **If two devices sell the last unit of something offline at the same
  time**, one of those sales will fail to sync (you'll see the error in
  Settings) rather than silently oversell — you'd then adjust that sale by
  hand.
- Until a sale syncs, its receipt is marked **"Pending sync"** and uses a
  temporary offline sale ID; the official sale ID and Sales-sheet entry are
  created once it syncs.

## Files in this folder

| File | Purpose |
|---|---|
| `index.html` | App layout (Inventory + Cashier tabs) |
| `styles.css` | Visual styling (same look as the Google Sheets version) |
| `app.js` | All logic: local storage, offline business rules, sync engine |
| `sw.js` | Service worker — caches the app so it loads with no connection |
| `manifest.json` | Makes it installable as an app |
| `icons/` | App icons |
