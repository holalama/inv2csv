/**
 * Golden test: the JS resolver port must produce the exact same
 * market_hash_name -> quantity map as the battle-tested Python pipeline
 * (inv-fetcher/resolve_names.py + build_table.py) on the repo's real GC dump.
 *
 * Run: node test_golden.js [dump.json]   (exits non-zero on any diff)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Resolver, aggregate } = require('./resolve');

const INV_FETCHER = path.join(__dirname, '..', 'inv-fetcher');
const DUMP = path.resolve(process.argv[2] || path.join(INV_FETCHER, 'data', 'gc_dump.json'));

const PY = `
import sys, json
sys.path.insert(0, '.')
from resolve_names import Resolver
from build_table import iter_located_items, _to_iso
r = Resolver()
agg = {}
for it, loc in iter_located_items(json.load(open(${JSON.stringify(DUMP)}))):
    name = r.resolve(it) or f"<unresolved def_index={it.get('def_index')}>"
    date = (_to_iso(it.get('tradable_after')) or '')[:10]
    key = f"{name}\\u0000{date}"
    agg[key] = agg.get(key, 0) + 1
print(json.dumps(agg, ensure_ascii=False))
`;

function pythonAgg() {
    for (const cmd of [['uv', ['run', 'python', '-c', PY]], ['python3', ['-c', PY]]]) {
        const r = spawnSync(cmd[0], cmd[1], { cwd: INV_FETCHER, encoding: 'utf8' });
        if (r.status === 0) return JSON.parse(r.stdout);
        if (r.error && r.error.code === 'ENOENT') continue; // try next interpreter
        throw new Error(`${cmd[0]} failed:\n${r.stderr}`);
    }
    throw new Error('no python interpreter found (tried uv, python3)');
}

function jsAgg() {
    // read the exact same schema files the python side parses
    const schema = (name) =>
        fs.readFileSync(path.join(INV_FETCHER, 'schema', name), 'utf8');
    const resolver = new Resolver(schema('items_game.txt'), schema('csgo_english.txt'));
    const dump = require(DUMP);
    const items = [
        ...(dump.top_level || []),
        ...(dump.storage_units || []).flatMap((su) => su.items || []),
    ];
    return Object.fromEntries(
        aggregate(items, resolver)
            .map((r) => [`${r.name}\u0000${r.tradable_after}`, r.quantity]),
    );
}

const py = pythonAgg();
const js = jsAgg();

let bad = 0;
for (const name of new Set([...Object.keys(py), ...Object.keys(js)])) {
    if (py[name] !== js[name]) {
        console.error(`DIFF ${JSON.stringify(name)}: python=${py[name]} js=${js[name]}`);
        bad++;
    }
}

const total = Object.values(py).reduce((s, q) => s + q, 0);
if (bad) {
    console.error(`FAIL: ${bad} name(s) differ (python total ${total} items, ${Object.keys(py).length} names)`);
    process.exit(1);
}
console.log(`OK: ${Object.keys(py).length} distinct names, ${total} items — JS matches Python exactly`);
