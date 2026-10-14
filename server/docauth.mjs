// Headless Document Authoring (Node.js entry point). Runs inside Skyjed's back end with
// no browser session: DOCX import, the clean-publish step, and comment extraction.
// In Skyjed's architecture this is a small Node.js service the .NET back end calls.
import { createDocAuthSystem } from '@nutrient-sdk/document-authoring/node';

let systemPromise = null;

function system() {
	systemPromise ??= createDocAuthSystem(process.env.DOCAUTH_NODE_LICENSE_KEY ? { licenseKey: process.env.DOCAUTH_NODE_LICENSE_KEY } : {});
	return systemPromise;
}

export async function importToDocJson(buffer, fileName) {
	const sys = await system();
	const doc = await sys.import(new Uint8Array(buffer), { fileName });
	return doc.saveDocument();
}

export async function blankDocJson() {
	const sys = await system();
	const doc = await sys.createDocumentFromPlaintext('', { pageSize: 'A4' });
	return doc.saveDocument();
}

// Everything the approval summary needs: open comment threads (with replies) and
// pending tracked changes, read before the document is cleaned.
export async function extractReview(docJson) {
	const sys = await system();
	const doc = await sys.loadDocument(docJson);
	return doc.transaction(async ({ draft }) => {
		const comments = draft.commentThreads().all().map((t) => ({
			id: t.id,
			resolved: t.resolved,
			anchorText: t.anchor?.ranges?.map((r) => r.text).join(' … ') ?? '',
			author: t.comment.author,
			createdAt: t.comment.createdAt,
			text: t.comment.text,
			replies: t.replies.map((r) => ({ author: r.author, createdAt: r.createdAt, text: r.text })),
		}));
		const revisions = draft.revisions().all().map((r) => ({
			id: r.id,
			type: r.type,
			author: r.author,
			date: r.date,
			preview: r.preview,
		}));
		return { commit: false, result: { comments, revisions } };
	});
}

// The "final tick": accept every insertion and deletion, strip all comments,
// and export clean DOCX + PDF. Returns the cleaned DocJSON too, which becomes the
// starting point of the next review cycle.
export async function publishClean(docJson) {
	const sys = await system();
	const doc = await sys.loadDocument(docJson);
	const review = await extractReview(docJson);
	const decision = await doc.transaction(async ({ draft }) => {
		const result = draft.revisions().accept({ all: true });
		for (const thread of draft.commentThreads().all()) thread.remove();
		return { commit: true, result };
	});
	const [docx, pdf, cleanDocJson] = await Promise.all([
		doc.export({ format: 'docx' }),
		doc.export({ format: 'pdf', PDF_A: true }),
		doc.saveDocument(),
	]);
	return {
		review,
		acceptedRevisionIds: decision.decided,
		docx: Buffer.from(docx),
		pdf: Buffer.from(pdf),
		cleanDocJson,
	};
}

export async function toPdf(docJson) {
	const sys = await system();
	const doc = await sys.loadDocument(docJson);
	return Buffer.from(await doc.export({ format: 'pdf' }));
}
