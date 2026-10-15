// Stand-in for Skyjed's .NET back end. It owns the workflow (draft → approval →
// published → next review), permissions, locking, the audit trail and the S3 "vault".
// Nutrient provides the editors (browser) and the document processing (Node.js
// Document Authoring + Document Engine), wired in through the calls below.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import express from 'express';
import multer from 'multer';
import * as da from './docauth.mjs';
import * as de from './engine.mjs';
import { DATA_DIR, USERS, audit, getAsset, load, newId, save, wipe } from './store.mjs';

const app = express();
app.use(express.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const PEN_TIMEOUT_MS = 15_000;
const workingDir = (a, cycle = a.cycle) => `${DATA_DIR}/working/${a.id}/cycle-${cycle}`;
const vaultDir = (a, cycle = a.cycle) => `${DATA_DIR}/vault/${a.id}/cycle-${cycle}`;

// ---------- workflow rules (Skyjed-owned) ----------

function capability(asset, userId) {
	if (asset.status === 'draft') return asset.owner === userId ? 'author' : 'read';
	if (asset.status === 'approval') {
		const pending = asset.approvers.includes(userId) && !asset.approvals[userId];
		return pending ? 'approver' : 'read';
	}
	return 'read';
}

function penHolder(asset) {
	const lock = asset.word?.lock;
	if (!lock) return null;
	return Date.now() - Date.parse(lock.heartbeatAt) > PEN_TIMEOUT_MS ? null : lock.userId;
}

function view(asset, userId) {
	return {
		...asset,
		word: asset.word && { ...asset.word, lock: undefined, penHolder: penHolder(asset) },
		you: { userId, capability: capability(asset, userId) },
	};
}

// ---------- vault (write once, read many) ----------

function writeVault(asset, name, data) {
	const dir = vaultDir(asset);
	mkdirSync(dir, { recursive: true });
	const path = `${dir}/${name}`;
	writeFileSync(path, data, { flag: 'wx' }); // refuses to overwrite
	chmodSync(path, 0o444);
	return name;
}

function slug(s) {
	return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

// ---------- Word working copy ----------

function saveWorkingVersion(asset, docJson, userId, note) {
	const version = (asset.word.version ?? 0) + 1;
	mkdirSync(workingDir(asset), { recursive: true });
	writeFileSync(`${workingDir(asset)}/v${version}.docjson`, JSON.stringify(docJson));
	asset.word.version = version;
	asset.word.versions.unshift({ version, cycle: asset.cycle, by: userId, at: new Date().toISOString(), note });
	return version;
}

function readWorking(asset, version = asset.word.version, cycle = asset.cycle) {
	return JSON.parse(readFileSync(`${workingDir(asset, cycle)}/v${version}.docjson`, 'utf8'));
}

// ---------- create assets ----------

async function createAsset({ title, fileName, buffer, risk, frequencyMonths, by, blank }) {
	const ext = extname(fileName ?? '').toLowerCase();
	const format = blank || ['.docx', '.dotx', '.docm', '.rtf', '.odt', '.md', '.txt'].includes(ext) ? 'word' : ext === '.pdf' ? 'pdf' : null;
	if (!format) throw new Error(`Unsupported file type: ${ext}`);
	const asset = {
		id: newId('COM'),
		title,
		format,
		sourceFile: fileName ?? 'New document',
		risk: risk ?? 'Medium',
		reviewFrequencyMonths: Number(frequencyMonths ?? 12),
		nextReviewDue: null,
		owner: 'alex',
		approvers: ['priya', 'sam'],
		approvalMode: 'parallel',
		status: 'draft',
		cycle: 1,
		approvals: {},
		approvalChannel: format,
		feedback: [],
		cycles: [],
		audit: [],
	};
	if (format === 'word') {
		asset.word = { version: 0, versions: [], lock: null };
		const docJson = blank ? await da.blankDocJson() : await da.importToDocJson(buffer, fileName);
		saveWorkingVersion(asset, docJson, by, blank ? 'Created from blank' : `Imported from ${fileName}`);
	} else {
		asset.pdf = { documentId: await de.uploadPdf(buffer, title) };
	}
	audit(asset, by, blank ? 'Created' : 'Uploaded', blank ? 'New Word document from blank' : `${fileName} → ${format === 'word' ? 'Document Authoring (DocJSON)' : 'Document Engine'}`);
	load().assets.push(asset);
	save();
	return asset;
}

// ---------- publish: the automatic "final tick" ----------

async function finalise(asset) {
	const cycle = asset.cycle;
	const record = { cycle, publishedAt: new Date().toISOString(), approvals: asset.approvals, files: {}, summary: null };
	const name = slug(asset.title);
	if (asset.format === 'word') {
		const working = readWorking(asset);
		const out = await da.publishClean(working);
		let pdfMarkups = [];
		if (asset.approvalChannel === 'pdf' && asset.approvalPdfId) {
			pdfMarkups = de.summarise(await de.instantJson(asset.approvalPdfId));
			record.files.reviewedPdf = writeVault(asset, `${name}-approval-markup.pdf`, await de.pdf(asset.approvalPdfId, { withAnnotations: true }));
		}
		record.summary = { comments: out.review.comments, revisions: out.review.revisions, pdfMarkups, feedback: asset.feedback };
		record.files.docx = writeVault(asset, `${name}.docx`, out.docx);
		record.files.pdf = writeVault(asset, `${name}.pdf`, out.pdf);
		mkdirSync(workingDir(asset), { recursive: true });
		writeFileSync(`${workingDir(asset)}/approved.docjson`, JSON.stringify(out.cleanDocJson));
		audit(asset, 'system', 'Published clean copy', `Accepted ${out.acceptedRevisionIds.length} tracked change(s), removed ${out.review.comments.length} comment thread(s), wrote DOCX + PDF/A to vault`);
	} else {
		const docId = asset.pdf.documentId;
		const markups = de.summarise(await de.instantJson(docId));
		record.summary = { pdfMarkups: markups, comments: [], revisions: [], feedback: asset.feedback };
		record.files.reviewedPdf = writeVault(asset, `${name}-approval-markup.pdf`, await de.pdf(docId, { withAnnotations: true }));
		record.files.pdf = writeVault(asset, `${name}.pdf`, await de.pdf(docId, { withAnnotations: false }));
		audit(asset, 'system', 'Published clean copy', `Removed ${markups.length} markup(s), wrote clean PDF + marked-up record to vault`);
	}
	record.files.summary = writeVault(asset, 'approval-summary.json', JSON.stringify(record, null, 2));
	asset.cycles.unshift(record);
	asset.status = 'published';
	const due = new Date();
	due.setMonth(due.getMonth() + asset.reviewFrequencyMonths);
	asset.nextReviewDue = due.toISOString();
	if (asset.word) asset.word.lock = null;
}

// ---------- routes ----------

const as = (req) => {
	const id = req.query.as ?? req.body?.as;
	if (!USERS[id]) throw Object.assign(new Error('Unknown user'), { status: 401 });
	return id;
};

const route = (fn) => async (req, res) => {
	try {
		await fn(req, res);
	} catch (e) {
		console.error(e);
		res.status(e.status ?? 500).json({ error: e.message });
	}
};

app.get('/api/config', (req, res) => {
	res.json({
		users: USERS,
		webSdkLicenseKey: process.env.WEB_SDK_LICENSE_KEY,
		docAuthLicenseKey: process.env.DOCAUTH_LICENSE_KEY,
		documentEngineUrl: `${process.env.DE_PUBLIC_URL ?? process.env.DE_URL}/`,
	});
});

app.get('/api/assets', route((req, res) => {
	const userId = as(req);
	res.json(load().assets.map((a) => view(a, userId)));
}));

app.get('/api/assets/:id', route((req, res) => {
	const a = getAsset(req.params.id);
	if (!a) return res.status(404).json({ error: 'Not found' });
	res.json(view(a, as(req)));
}));

app.post('/api/assets', upload.single('file'), route(async (req, res) => {
	const by = as(req);
	const f = req.file;
	const a = await createAsset({
		title: req.body.title || basename(f.originalname, extname(f.originalname)),
		fileName: f.originalname,
		buffer: f.buffer,
		risk: req.body.risk,
		frequencyMonths: req.body.frequencyMonths,
		by,
	});
	res.json(view(a, by));
}));

app.post('/api/assets/blank', route(async (req, res) => {
	const by = as(req);
	const a = await createAsset({ title: req.body.title || 'Untitled communication', blank: true, risk: req.body.risk, frequencyMonths: req.body.frequencyMonths, by });
	res.json(view(a, by));
}));

// Word working copy (DocJSON). `version` lets a reader view any earlier version.
app.get('/api/assets/:id/word', route((req, res) => {
	const a = getAsset(req.params.id);
	const version = Number(req.query.version ?? a.word.version);
	const cycle = Number(req.query.cycle ?? a.cycle);
	res.json({ version, cycle, docJson: readWorking(a, version, cycle) });
}));

// Save = new immutable working version. Requires the pen, and rejects stale saves
// (someone else saved since you loaded) instead of silently overwriting.
app.put('/api/assets/:id/word', route((req, res) => {
	const userId = as(req);
	const a = getAsset(req.params.id);
	const cap = capability(a, userId);
	if (cap === 'read') return res.status(403).json({ error: 'You have read-only access at this stage' });
	if (penHolder(a) !== userId) return res.status(423).json({ error: 'Take the pen before editing', penHolder: penHolder(a) });
	if (req.body.baseVersion !== a.word.version) return res.status(409).json({ error: 'Stale copy', version: a.word.version });
	const version = saveWorkingVersion(a, req.body.docJson, userId, cap === 'approver' ? 'Review suggestions' : 'Edited');
	a.word.lock.heartbeatAt = new Date().toISOString();
	save();
	res.json({ version });
}));

// The "pen": one writer at a time in the Word document, everyone else follows live.
app.post('/api/assets/:id/pen', route((req, res) => {
	const userId = as(req);
	const a = getAsset(req.params.id);
	const holder = penHolder(a);
	const now = new Date().toISOString();
	const { action } = req.body;
	if (action === 'release') {
		if (holder === userId) {
			a.word.lock = null;
			audit(a, userId, 'Released pen', `Working copy v${a.word.version}`);
		}
	} else {
		if (capability(a, userId) === 'read') return res.status(403).json({ error: 'Read-only at this stage' });
		if (holder && holder !== userId) return res.status(423).json({ error: `${USERS[holder].name} is editing`, penHolder: holder });
		if (!holder) audit(a, userId, 'Took pen', `Working copy v${a.word.version}`);
		a.word.lock = { userId, at: a.word.lock?.at ?? now, heartbeatAt: now };
	}
	save();
	res.json({ penHolder: penHolder(a), version: a.word.version });
}));

// Web SDK session for a PDF: which document to open and a JWT carrying this user's permissions.
app.get('/api/assets/:id/pdf-session', route((req, res) => {
	const userId = as(req);
	const a = getAsset(req.params.id);
	const documentId = a.format === 'pdf' ? a.pdf.documentId : a.approvalPdfId;
	const cap = capability(a, userId);
	res.json({ documentId, capability: cap, jwt: de.viewerToken({ documentId, user: USERS[userId], capability: cap }) });
}));

// What the approval summary will contain if the asset were published right now.
app.get('/api/assets/:id/review', route(async (req, res) => {
	const a = getAsset(req.params.id);
	const out = { comments: [], revisions: [], pdfMarkups: [] };
	if (a.format === 'word') Object.assign(out, await da.extractReview(readWorking(a)));
	// For Word reviewed on a PDF snapshot, keep showing the approvers' markup after "request changes".
	const pdfId = a.format === 'pdf' ? a.pdf.documentId : a.approvalChannel === 'pdf' ? a.approvalPdfId : null;
	if (pdfId) out.pdfMarkups = de.summarise(await de.instantJson(pdfId));
	res.json(out);
}));

app.post('/api/assets/:id/submit', route(async (req, res) => {
	const userId = as(req);
	const a = getAsset(req.params.id);
	if (a.status !== 'draft' || a.owner !== userId) return res.status(403).json({ error: 'Only the owner can submit a draft' });
	a.approvalChannel = a.format === 'word' ? (req.body.channel === 'pdf' ? 'pdf' : 'word') : 'pdf';
	if (a.format === 'word' && a.approvalChannel === 'pdf') {
		a.approvalPdfId = await de.uploadPdf(await da.toPdf(readWorking(a)), `${a.title} (approval snapshot v${a.word.version})`);
	}
	a.status = 'approval';
	a.approvals = {};
	if (a.word) a.word.lock = null;
	audit(a, userId, 'Submitted for approval', `${a.approvers.map((u) => USERS[u].name).join(' + ')} in parallel · ${a.format === 'word' ? (a.approvalChannel === 'pdf' ? 'on a PDF snapshot (concurrent markup)' : 'in Word review mode (tracked changes)') : 'on the PDF (concurrent markup)'}`);
	save();
	res.json(view(a, userId));
}));

app.post('/api/assets/:id/decision', route(async (req, res) => {
	const userId = as(req);
	const a = getAsset(req.params.id);
	if (capability(a, userId) !== 'approver') return res.status(403).json({ error: 'Not an approver on this step' });
	const { decision, note } = req.body;
	a.approvals[userId] = { decision, note: note ?? '', at: new Date().toISOString() };
	if (penHolder(a) === userId) a.word.lock = null;
	audit(a, userId, decision === 'approve' ? 'Approved' : 'Requested changes', note ?? '');
	if (note) a.feedback.push({ by: userId, at: new Date().toISOString(), note, cycle: a.cycle });
	if (decision === 'changes') {
		a.status = 'draft';
		audit(a, 'system', 'Returned to draft', `${USERS[userId].name} requested changes; review markup is kept for the owner`);
	} else if (a.approvers.every((u) => a.approvals[u]?.decision === 'approve')) {
		audit(a, 'system', 'All approvals complete', 'Publishing clean copy automatically');
		await finalise(a);
	}
	save();
	res.json(view(a, userId));
}));

// Next review: the last approved, clean version becomes the new working copy.
app.post('/api/assets/:id/next-cycle', route(async (req, res) => {
	const userId = as(req);
	const a = getAsset(req.params.id);
	if (a.status !== 'published' || a.owner !== userId) return res.status(403).json({ error: 'Only the owner can start the next review of a published asset' });
	const prev = a.cycle;
	a.cycle += 1;
	a.status = 'draft';
	a.approvals = {};
	a.feedback = [];
	a.approvalPdfId = null;
	if (a.format === 'word') {
		const approved = JSON.parse(readFileSync(`${workingDir(a, prev)}/approved.docjson`, 'utf8'));
		saveWorkingVersion(a, approved, userId, `Started from approved cycle ${prev}`);
	} else {
		const clean = readFileSync(`${vaultDir(a, prev)}/${a.cycles[0].files.pdf}`);
		a.pdf.previousDocumentIds = [...(a.pdf.previousDocumentIds ?? []), a.pdf.documentId];
		a.pdf.documentId = await de.uploadPdf(clean, `${a.title} (cycle ${a.cycle})`);
	}
	audit(a, userId, 'Started review cycle', `Cycle ${a.cycle} working copy created from the approved cycle ${prev} version`);
	save();
	res.json(view(a, userId));
}));

app.get('/api/assets/:id/vault/:cycle/:file', route((req, res) => {
	const a = getAsset(req.params.id);
	const path = `${vaultDir(a, Number(req.params.cycle))}/${basename(req.params.file)}`;
	if (!existsSync(path)) return res.status(404).end();
	res.download(path);
}));

// ---------- seed the register from samples/ ----------
// Every Word/PDF file in samples/ is loaded on first start. samples/samples.json can
// give a file a friendlier title, risk rating and review frequency.

function seedList() {
	const meta = existsSync('samples/samples.json') ? JSON.parse(readFileSync('samples/samples.json', 'utf8')) : {};
	const files = existsSync('samples') ? readdirSync('samples').filter((f) => /\.(docx|pdf)$/i.test(f)).sort() : [];
	return files.map((file) => ({
		file,
		title: basename(file, extname(file)).replace(/[_-]+/g, ' ').trim(),
		risk: 'Medium',
		frequencyMonths: 12,
		...meta[file],
	}));
}

async function seed() {
	if (load().seeded) return;
	const list = seedList();
	if (!list.length) console.log('No files in samples/. Upload documents from the register instead.');
	for (const s of list) {
		if (load().assets.some((a) => a.sourceFile === s.file)) continue;
		for (let attempt = 0; ; attempt++) {
			try {
				await createAsset({ ...s, fileName: s.file, buffer: readFileSync(`samples/${s.file}`), by: 'alex' });
				console.log(`Seeded: ${s.title}`);
				break;
			} catch (e) {
				if (attempt % 5 === 0) console.log(`Waiting for Document Engine at ${process.env.DE_URL}… (${e.message.slice(0, 60)})`);
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}
	load().seeded = true;
	save();
}

// Start over: remove every asset (and its Document Engine documents), the working
// copies and the vault, then load samples/ again.
let seeding = null;
app.post('/api/reset', route(async (req, res) => {
	as(req);
	if (seeding) await seeding.catch(() => {});
	const docIds = load().assets.flatMap((a) => [a.pdf?.documentId, ...(a.pdf?.previousDocumentIds ?? []), a.approvalPdfId]).filter(Boolean);
	wipe();
	await Promise.all(docIds.map((id) => de.deleteDocument(id).catch(() => {})));
	seeding = seed();
	await seeding;
	res.json({ assets: load().assets.length });
}));

const port = Number(process.env.API_PORT ?? 3001);
app.listen(port, () => {
	console.log(`Demo API on http://localhost:${port}`);
	seeding = seed();
	seeding.catch((e) => console.error('Seeding failed', e));
});
