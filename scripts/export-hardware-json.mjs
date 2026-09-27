#!/usr/bin/env node
// Writes the generated hardware database to data/hardware-db.json so it can be
// inspected, diffed or consumed by other tools. The app itself generates the
// same data at runtime from src/hardware/.
import { writeFile, mkdir } from 'node:fs/promises';
import { exportDatabase } from '../src/hardware/index.js';

const db = exportDatabase();
delete db.generated; // keep the file deterministic
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/hardware-db.json', import.meta.url), `${JSON.stringify(db, null, 2)}\n`);
console.log(`Wrote ${db.bookshelf.length} bookshelf speakers and ${db.subwoofers.length} subwoofers to data/hardware-db.json`);
