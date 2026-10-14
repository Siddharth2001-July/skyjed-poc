// Document Engine REST client + JWT issuing. Document Engine runs as a container in
// the customer's own AWS account; Skyjed's back end is the only thing that talks to its
// REST API (with API_AUTH_TOKEN). Browsers only ever get a short-lived, per-user JWT.
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';

const DE = () => process.env.DE_URL ?? 'http://localhost:5001';
const auth = () => ({ Authorization: `Token token=${process.env.DE_API_TOKEN}` });
const privateKey = readFileSync('keys/jwt_private.pem', 'utf8');

async function check(res, what) {
	if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
	return res;
}

export async function uploadPdf(buffer, title) {
	const form = new FormData();
	form.append('file', new Blob([buffer], { type: 'application/pdf' }), `${title}.pdf`);
	form.append('title', title);
	const res = await check(await fetch(`${DE()}/api/documents`, { method: 'POST', headers: auth(), body: form }), 'Upload');
	return (await res.json()).data.document_id;
}

export async function instantJson(documentId) {
	const res = await check(await fetch(`${DE()}/api/documents/${documentId}/document.json`, { headers: auth() }), 'Export Instant JSON');
	return res.json();
}

async function download(documentId, query = '') {
	const res = await check(await fetch(`${DE()}/api/documents/${documentId}/pdf${query}`, { headers: auth() }), 'Download PDF');
	return Buffer.from(await res.arrayBuffer());
}

async function deleteDocument(documentId) {
	await fetch(`${DE()}/api/documents/${documentId}`, { method: 'DELETE', headers: auth() });
}

// The current PDF (including content-editor changes), either with the review markup
// burned in (the approval record) or clean (all annotations and comments removed).
// The clean copy is made on a throwaway copy so the working document keeps its markup.
export async function pdf(documentId, { withAnnotations }) {
	if (withAnnotations) return download(documentId, '?flatten=true');
	const tempId = await uploadPdf(await download(documentId), 'clean-publish-temp');
	try {
		const headers = { ...auth(), Accept: 'application/json' };
		const res = await check(await fetch(`${DE()}/api/documents/${tempId}/annotations`, { headers }), 'List annotations');
		const { annotations } = (await res.json()).data;
		for (const a of annotations) {
			await check(await fetch(`${DE()}/api/documents/${tempId}/annotations/${a.id}`, { method: 'DELETE', headers }), 'Delete annotation');
		}
		return await download(tempId);
	} finally {
		await deleteDocument(tempId);
	}
}

// Collaboration permissions are derived from Skyjed's own workflow state:
// who you are, what stage the asset is in, and whether you're an approver on it.
export function viewerToken({ documentId, user, capability }) {
	const base = {
		document_id: documentId,
		user_id: user.id,
		exp: Math.floor(Date.now() / 1000) + 60 * 60,
	};
	const readOnly = {
		permissions: ['read-document', 'download'],
		collaboration_permissions: ['annotations:view:all', 'comments:view:all'],
	};
	const claims = {
		// Draft: the owner annotates and edits page content.
		author: {
			permissions: ['read-document', 'write', 'download'],
			collaboration_permissions: [
				'annotations:view:all', 'annotations:edit:all', 'annotations:delete:all',
				'comments:view:all', 'comments:edit:all', 'comments:delete:all', 'comments:reply:all',
			],
		},
		// Approval: every approver marks up at the same time, but can only change their own markup.
		approver: {
			permissions: ['read-document', 'write', 'download'],
			collaboration_permissions: [
				'annotations:view:all', 'annotations:edit:self', 'annotations:delete:self',
				'comments:view:all', 'comments:edit:self', 'comments:delete:self', 'comments:reply:all',
			],
		},
		read: readOnly,
	}[capability] ?? readOnly;
	return jwt.sign({ ...base, ...claims }, privateKey, { algorithm: 'RS256' });
}

// Flatten Instant JSON into rows for Skyjed's approval summary.
export function summarise(instant) {
	const annotations = instant.annotations ?? [];
	const comments = instant.comments ?? [];
	const plain = (t) => (typeof t === 'string' ? t : t?.value ?? '').replace(/<[^>]+>/g, '').trim();
	const label = {
		'pspdfkit/markup/strikeout': 'Strikeout',
		'pspdfkit/markup/highlight': 'Highlight',
		'pspdfkit/markup/underline': 'Underline',
		'pspdfkit/markup/squiggly': 'Squiggly',
		'pspdfkit/text': 'Text box',
		'pspdfkit/note': 'Note',
		'pspdfkit/comment-marker': 'Comment',
		'pspdfkit/ink': 'Freehand',
		'pspdfkit/shape/rectangle': 'Box',
		'pspdfkit/shape/ellipse': 'Circle',
		'pspdfkit/shape/line': 'Arrow / line',
		'pspdfkit/stamp': 'Stamp',
	};
	const markups = annotations.map((a) => ({
		id: a.id ?? a.name,
		type: label[a.type] ?? a.type.replace('pspdfkit/', ''),
		page: (a.pageIndex ?? 0) + 1,
		author: a.creatorName ?? a.createdBy ?? null,
		createdAt: a.createdAt ?? null,
		text: plain(a.text) || plain(a.note) || '',
		comments: comments
			.filter((c) => c.rootId === (a.id ?? a.name))
			.map((c) => ({ author: c.creatorName ?? c.createdBy, createdAt: c.createdAt, text: plain(c.text) })),
	}));
	return markups;
}
