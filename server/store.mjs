// Minimal JSON-file persistence standing in for Skyjed's own database.
// Everything here (assets, approvals, audit trail, locks) is Skyjed-owned state;
// Nutrient components never need to know about it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DATA_DIR = 'data';
const DB_FILE = `${DATA_DIR}/db.json`;

export const USERS = {
	alex: { id: 'alex', name: 'Alex Morgan', title: 'Product Owner (asset owner)', kind: 'author' },
	priya: { id: 'priya', name: 'Priya Shah', title: 'Compliance approver', kind: 'approver' },
	sam: { id: 'sam', name: 'Sam Taylor', title: 'Legal & Risk approver', kind: 'approver' },
	jordan: { id: 'jordan', name: 'Jordan Lee', title: 'Business unit viewer', kind: 'viewer' },
};

let db = null;

export function load() {
	if (db) return db;
	db = existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, 'utf8')) : { assets: [] };
	return db;
}

export function save() {
	mkdirSync(dirname(DB_FILE), { recursive: true });
	writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

export function getAsset(id) {
	return load().assets.find((a) => a.id === id);
}

export function audit(asset, userId, action, detail = '') {
	asset.audit.unshift({ at: new Date().toISOString(), user: userId, action, detail, cycle: asset.cycle });
}

export function newId(prefix) {
	return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
