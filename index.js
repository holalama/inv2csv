#!/usr/bin/env node
/**
 * Export your full CS2 inventory — INCLUDING storage-unit contents — to
 * inventory.csv (market_hash_name,quantity).
 *
 * Usage: node index.js
 *
 * Login is QR-only: scan the code with the Steam mobile app. No password is
 * typed and NOTHING is ever written to disk except inventory.csv — the refresh
 * token lives in process memory and dies with the process, the raw item dump
 * is never persisted, and the game schema is fetched fresh into memory each
 * run. Every run is a fresh QR scan.
 *
 * You must NOT be running CS2 on this account while this runs.
 */
const fs = require('fs');
const path = require('path');
const SteamUser = require('steam-user');
const NodeCS2 = require('node-cs2');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const qrcode = require('qrcode');
const { Resolver, aggregate } = require('./resolve');

const OUT = path.join(process.cwd(), 'inventory.csv');

const SETTLE_POLL_MS = 1000;   // how often to check inventory size
const SETTLE_STABLE = 3;       // consecutive unchanged polls => inventory settled
const SETTLE_MAX_MS = 30000;   // give up waiting after this
const CASKET_DELAY_MS = 1500;  // polite delay between casket loads
const CASKET_RETRIES = 3;      // getCasketContents attempts (backoff between)

const SCHEMA_RAW = 'https://raw.githubusercontent.com/SteamDatabase/GameTracking-CS2/master/game/csgo/pak01_dir';
const SCHEMA_FILES = {
    'items_game.txt': `${SCHEMA_RAW}/scripts/items/items_game.txt`,
    'csgo_english.txt': `${SCHEMA_RAW}/resource/csgo_english.txt`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => { console.error('FATAL:', msg); process.exit(1); };

function ask(q) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

// Always fetched fresh, kept in memory only: no stale-schema failure mode,
// and nothing but inventory.csv ever touches the disk.
async function fetchSchema(name) {
    const url = SCHEMA_FILES[name];
    console.log(`Downloading ${name} ...`);
    const resp = await fetch(url);
    if (!resp.ok) die(`schema download failed: ${url} -> HTTP ${resp.status}`);
    const text = await resp.text();
    console.log(`  ${text.length.toLocaleString()} bytes`);
    return text;
}

async function waitForInventory(cs2) {
    const start = Date.now();
    let last = -1, stable = 0;
    while (Date.now() - start < SETTLE_MAX_MS) {
        const n = (cs2.inventory || []).length;
        if (n > 0 && n === last) {
            if (++stable >= SETTLE_STABLE) return n;
        } else {
            stable = 0;
        }
        last = n;
        await sleep(SETTLE_POLL_MS);
    }
    return (cs2.inventory || []).length;
}

async function getCasket(cs2, id) {
    for (let attempt = 1; attempt <= CASKET_RETRIES; attempt++) {
        try {
            return await cs2.getCasketContents(id);
        } catch (e) {
            if (attempt === CASKET_RETRIES) throw e;
            const backoff = CASKET_DELAY_MS * 2 ** attempt;
            console.log(`    retry ${attempt}/${CASKET_RETRIES - 1} after ${e.message} (${backoff}ms)`);
            await sleep(backoff);
        }
    }
}

function csvField(s) {
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(rows, out) {
    const lines = ['market_hash_name,quantity,tradable_after'];
    for (const r of rows) lines.push(`${csvField(r.name)},${r.quantity},${r.tradable_after}`);
    fs.writeFileSync(out, lines.join('\n') + '\n');
}

async function main() {
    console.log('For safety reasons it is recommended to NOT have CS2 running on this account while this script runs.');
    const ok = await ask('Continue? [y/N] ');
    if (ok.toLowerCase() !== 'y') { console.log('Aborted.'); process.exit(0); }

    console.log('\nDownloading two game files for item name resolution...');
    // fail fast, before asking the user to scan
    const resolver = new Resolver(
        await fetchSchema('items_game.txt'),
        await fetchSchema('csgo_english.txt'),
    );

    const user = new SteamUser();
    const cs2 = new NodeCS2(user);
    let done = false;

    user.on('error', (e) => die(`Steam error: ${e.message}`));
    user.on('disconnected', () => { if (!done) die('disconnected from Steam before export finished'); });

    // QR-only login: no password, no Guard code, no token cache. The refresh
    // token stays in memory and is gone when the process exits.
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    session.on('remoteInteraction', () => console.log('QR scanned — approve in the Steam app...'));
    session.on('timeout', () => die('QR login timed out — run again'));
    session.on('error', (e) => die(`QR login error: ${e.message}`));
    session.on('authenticated', () => {
        console.log('Authenticated. Logging on...');
        user.logOn({ refreshToken: session.refreshToken });
    });
    const { qrChallengeUrl } = await session.startWithQR();
    console.log('\nScan this QR code with the Steam mobile app:\n');
    console.log(await qrcode.toString(qrChallengeUrl, { type: 'terminal', small: true }));

    user.on('loggedOn', () => { console.log('Logged on. Launching CS2...'); user.gamesPlayed([730]); });
    user.on('appLaunched', (appid) => { if (appid === 730) { console.log('Connecting to GC...'); cs2.helloGC(); } });
    cs2.on('disconnectedFromGC', () => { if (!done) console.log('GC disconnected; awaiting reconnect...'); });

    // If the GC drops mid-run, helloGC re-runs connectedToGC — guard re-entry.
    let running = false;
    cs2.on('connectedToGC', async () => {
        if (running || done) return;
        running = true;
        try {
            console.log('Connected to GC. Waiting for inventory to settle...');
            await waitForInventory(cs2);
            const inv = cs2.inventory || [];
            const topLevel = inv.filter((i) => !i.casket_id);
            console.log(`Top-level inventory items: ${topLevel.length}`);

            const caskets = inv.filter((i) => typeof i.casket_contained_item_count === 'number');
            console.log(`Storage units found: ${caskets.length}`);

            const allItems = [...topLevel];
            for (const c of caskets) {
                const name = c.custom_name || `Storage Unit ${c.id}`;
                if (!c.casket_contained_item_count) {
                    console.log(`  "${name}" empty, skipping`);
                    continue;
                }
                process.stdout.write(`  Loading "${name}" (${c.casket_contained_item_count} items)... `);
                const items = await getCasket(cs2, c.id);
                console.log(`got ${items.length}`);
                allItems.push(...items);
                await sleep(CASKET_DELAY_MS);
            }

            const rows = aggregate(allItems, resolver);
            writeCsv(rows, OUT);
            const total = rows.reduce((s, r) => s + r.quantity, 0);
            const names = new Set(rows.map((r) => r.name)).size;
            console.log(`\nWrote ${OUT}`);
            console.log(`  ${total} items across ${names} distinct names (${rows.length} rows)`);

            done = true;
            user.logOff();
            process.exit(0);
        } catch (e) {
            die(`export failed: ${e.message}`);
        }
    });
}

main();
