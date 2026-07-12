/**
 * Resolve CS2 Game-Coordinator (GC) raw econ items to market_hash_name.
 * JS port of inv-fetcher/resolve_names.py (resolve() path only) plus the
 * phantom-item filter from inv-fetcher/build_table.py.
 *
 * Data: schema/items_game.txt + schema/csgo_english.txt from
 * SteamDatabase/GameTracking-CS2. Pure transform, no network.
 */
const VDF = require('vdf-parser');

// arrayify:false matches python vdf merge_duplicate_keys=True (duplicate dict
// keys deep-merge, duplicate scalars last-wins); types:false keeps values as
// strings like python vdf does.
const VDF_OPTS = { arrayify: false, types: false };

/** Parse raw schema file contents (items_game.txt / csgo_english.txt). */
function parseSchema(itemsGameText, csgoEnglishText) {
    const strip = (s) => s.replace(/^﻿/, '');
    const ig = VDF.parse(strip(itemsGameText), VDF_OPTS).items_game;
    const en = VDF.parse(strip(csgoEnglishText), VDF_OPTS);
    const tokens = (en.lang && en.lang.Tokens) || {};
    const loc = {};
    for (const [k, v] of Object.entries(tokens)) loc[k.toLowerCase()] = v;
    return { ig, loc };
}

const WEAR_BUCKETS = [
    [0.07, 'Factory New'],
    [0.15, 'Minimal Wear'],
    [0.38, 'Field-Tested'],
    [0.45, 'Well-Worn'],
    [1.01, 'Battle-Scarred'],
];

function wearName(w) {
    if (w == null) return null;
    for (const [hi, name] of WEAR_BUCKETS) if (w < hi) return name;
    return 'Battle-Scarred';
}

/** Read a 32-bit value from a GC attribute (value, live Buffer, or JSON-serialized Buffer). */
function u32(attr) {
    if (attr.value != null) return Number(attr.value);
    let vb = attr.value_bytes;
    if (vb && !Buffer.isBuffer(vb) && vb.data) vb = Buffer.from(vb.data);
    if (Buffer.isBuffer(vb)) {
        const b = Buffer.alloc(4);
        vb.copy(b, 0, 0, Math.min(4, vb.length));
        return b.readUInt32LE(0);
    }
    return null;
}

class Resolver {
    /** @param itemsGameText raw items_game.txt @param csgoEnglishText raw csgo_english.txt */
    constructor(itemsGameText, csgoEnglishText) {
        const { ig, loc } = parseSchema(itemsGameText, csgoEnglishText);
        this.ig = ig;
        this.loc = loc;
        this.items = ig.items || {};
        this.paintKits = ig.paint_kits || {};
        this.stickerKits = ig.sticker_kits || {};
        this.music = ig.music_definitions || {};
        this.prefabs = ig.prefabs || {};
        this.keychains = ig.keychain_definitions || {};
    }

    /** Localize a #Token; pass through plain strings. */
    L(token) {
        if (token == null) return null;
        const t = String(token).startsWith('#') ? String(token).slice(1) : String(token);
        return this.loc[t.toLowerCase()] ?? token;
    }

    // -- prefab inheritance: resolve an item field, walking the prefab chain
    itemField(itemDef, field, depth = 0) {
        if (depth > 8 || itemDef == null || typeof itemDef !== 'object') return null;
        if (field in itemDef) return itemDef[field];
        const prefab = itemDef.prefab;
        if (prefab) {
            for (const p of String(prefab).split(/\s+/)) {
                const v = this.itemField(this.prefabs[p], field, depth + 1);
                if (v != null) return v;
            }
        }
        return null;
    }

    prefabChain(itemDef, depth = 0) {
        if (depth > 8 || itemDef == null || typeof itemDef !== 'object') return [];
        const out = [];
        for (const p of String(itemDef.prefab || '').split(/\s+/).filter(Boolean)) {
            out.push(p);
            out.push(...this.prefabChain(this.prefabs[p], depth + 1));
        }
        return out;
    }

    weaponName(defIndex) {
        const it = this.items[String(defIndex)];
        if (!it) return null;
        const token = this.itemField(it, 'item_name');
        return token ? this.L(token) : null;
    }

    isStattrak(gc) {
        if (gc.quality === 9) return true; // strange
        for (const a of gc.attribute || []) {
            if (a.def_index === 80 || a.def_index === 81) return true; // kill eater
        }
        return false;
    }

    isSouvenir(gc) {
        return gc.quality === 12;
    }

    /** Knives and gloves get the ★ market_hash_name prefix. */
    needsStar(defIndex) {
        const it = this.items[String(defIndex)];
        if (!it) return false;
        // Zeus x27 shares the "melee" gear slot but is not a knife — no ★ on market
        if (this.itemField(it, 'item_class') === 'weapon_taser') return false;
        if (this.itemField(it, 'item_gear_slot') === 'melee') return true;
        return this.prefabChain(it).includes('hands');
    }

    keychainName(kid) {
        const kd = kid != null ? this.keychains[String(kid)] : null;
        return kd ? this.L(kd.loc_name) : null;
    }

    paintKitName(paintIndex) {
        const pk = this.paintKits[String(paintIndex)];
        if (!pk) return null;
        return pk.description_tag ? this.L(pk.description_tag) : (pk.name ?? null);
    }

    /** Return market_hash_name (best effort) for a raw GC item. */
    resolve(gc) {
        const defIndex = gc.def_index;
        const paint = gc.paint_index || 0;

        // --- music kits (def 1314 / 1315) ---
        if (defIndex === 1314 || defIndex === 1315) {
            for (const a of gc.attribute || []) {
                if (a.def_index === 166) { // music id
                    const md = this.music[String(u32(a))];
                    if (md) {
                        const nm = this.L(md.loc_name);
                        // Owned StatTrak kits come through as def 1314 with the
                        // kill-eater attribute, not as def 1315 (the store box).
                        const st = (defIndex === 1315 || this.isStattrak(gc)) ? 'StatTrak™ ' : '';
                        return `${st}Music Kit | ${nm}`;
                    }
                }
            }
            return null;
        }

        // --- graffiti: 1348 'spray' = Sealed (marketable), 1349 'spraypaint' =
        //     unsealed/applied charges (cannot-trade, no market price). ---
        if (defIndex === 1348 || defIndex === 1349) {
            const label = defIndex === 1348 ? 'Sealed Graffiti' : 'Graffiti';
            let kitId = null, tintId = null;
            for (const a of gc.attribute || []) {
                if (a.def_index === 113) kitId = u32(a);       // sticker slot 0 id == graffiti kit
                else if (a.def_index === 233) tintId = u32(a); // spray tint id
            }
            if (kitId != null) {
                const sk = this.stickerKits[String(kitId)];
                if (sk) {
                    const nm = this.L(sk.item_name);
                    if (tintId) {
                        const color = this.loc[`attrib_spraytintvalue_${tintId}`];
                        return color ? `${label} | ${nm} (${color})` : `${label} | ${nm}`;
                    }
                    return `${label} | ${nm}`;
                }
            }
            return label;
        }

        // --- charm / keychain (def 1355); identity in attribute 299 ---
        if (defIndex === 1355) {
            for (const a of gc.attribute || []) {
                if (a.def_index === 299) { // keychain slot 0 id
                    const nm = this.keychainName(u32(a));
                    if (nm) return `Charm | ${nm}`;
                }
            }
            return null;
        }

        // --- stickers (def 1209) ---
        if (defIndex === 1209) {
            for (const a of gc.attribute || []) {
                if (a.def_index === 113) {
                    const sk = this.stickerKits[String(u32(a))];
                    if (sk) return `Sticker | ${this.L(sk.item_name)}`;
                }
            }
            return null;
        }

        // --- patches (def 4609) ---
        if (defIndex === 4609) {
            for (const a of gc.attribute || []) {
                if (a.def_index === 113) {
                    const sk = this.stickerKits[String(u32(a))];
                    if (sk) return `Patch | ${this.L(sk.item_name)}`;
                }
            }
            return null;
        }

        const base = this.weaponName(defIndex);
        const star = this.needsStar(defIndex) ? '★ ' : '';

        // --- weapons / knives / gloves with a paint kit ---
        if (base && paint) {
            const pkname = this.paintKitName(paint);
            const wear = wearName(gc.paint_wear ?? null);
            let prefix = '';
            if (this.isSouvenir(gc)) prefix = 'Souvenir ';
            else if (this.isStattrak(gc)) prefix = 'StatTrak™ ';
            let name = `${star}${prefix}${base} | ${pkname}`;
            if (wear) name += ` (${wear})`;
            return name;
        }

        // --- vanilla knife (★) / item with no paint (base name only) ---
        if (base) return `${star}${base}`;

        return null;
    }
}

// --- phantom-item filter, ported from inv-fetcher/build_table.py ---

// The GC returns synthetic "default"/placeholder items with asset IDs in the
// 0xF000_0000_0000_0000+ range; real economy IDs are ~11-13 digits.
const SYNTHETIC_ID_MIN = 0xF000000000000000n;

// Attribute 277 = "free reward status": unclaimed weekly care-package offers
// appear as inventory items even though they aren't owned yet.
const FREE_REWARD_ATTR = 277;

function isRealItem(it) {
    if ((it.attribute || []).some((a) => a.def_index === FREE_REWARD_ATTR)) return false;
    try {
        return BigInt(it.id) < SYNTHETIC_ID_MIN;
    } catch {
        return true; // unparseable id -> keep, don't silently drop real items
    }
}

/** Trade-lock expiry as YYYY-MM-DD, or '' if the item never had one.
 *  For trade/market acquisitions this is acquisition date + 7 days. */
function tradableDate(it) {
    const v = it.tradable_after;
    if (!v) return ''; // null/0 = never locked (matches build_table._to_iso)
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'number') return new Date(v * 1000).toISOString().slice(0, 10);
    return String(v).slice(0, 10);
}

/** Aggregate raw GC items into rows {name, tradable_after, quantity},
 *  grouped by (market_hash_name, tradable-after date), sorted. */
function aggregate(items, resolver) {
    const counts = new Map();
    for (const it of items) {
        if (!isRealItem(it)) continue;
        const name = resolver.resolve(it) || `<unresolved def_index=${it.def_index}>`;
        const key = `${name}\u0000${tradableDate(it)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts]
        .map(([key, quantity]) => {
            const [name, tradable_after] = key.split('\u0000');
            return { name, tradable_after, quantity };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 :
            a.tradable_after < b.tradable_after ? -1 : a.tradable_after > b.tradable_after ? 1 : 0));
}

module.exports = { Resolver, isRealItem, aggregate };
