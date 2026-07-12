# inv2csv

Export your full CS2 inventory — **including storage-unit contents** — to `inventory.csv` (`market_hash_name,quantity`).

## Requirements

Node.js 18+ and the Steam mobile app (for QR login). CS2 must not be running on the account while this runs.

## Usage

```
npx inv2csv
```

(or from a checkout: `npm install && node index.js`)

Scan the QR code with the Steam mobile app, approve, done — `inventory.csv` appears in the current directory. The item schema is fetched fresh on every run, so names are always current.

Columns: `market_hash_name,quantity,tradable_after`. Rows are grouped by name **and** trade-lock date, so the same item acquired at different times appears on separate rows. `tradable_after` is the date the item's trade lock expired (or expires); for items acquired by trade or market purchase that is **acquisition date + 7 days**, so it tells you roughly how long the item has been in the inventory. Empty = the item never had a trade lock (e.g. unboxed drops), so its age can't be derived.

## Privacy

No login data is ever stored: no password is typed, and the login token lives only in process memory — every run is a fresh QR scan. **Nothing is written to disk except `inventory.csv`.**

## Out of scope

Password/2FA login, prices, per-storage-unit breakdown, float/sticker details.
