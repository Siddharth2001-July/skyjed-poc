import { useEffect, useRef, useState } from 'react';
import { api, fmt } from './api.js';

export const STAGE = { draft: 'Draft', approval: 'In approval', published: 'Published' };

export default function Register({ config, user }) {
	const [assets, setAssets] = useState(null);
	const [busy, setBusy] = useState('');
	const [error, setError] = useState('');
	const fileRef = useRef();

	const refresh = () => api.get('/assets').then(setAssets);
	useEffect(() => {
		refresh();
		const t = setInterval(refresh, 3000);
		return () => clearInterval(t);
	}, []);

	async function onUpload(e) {
		const file = e.target.files[0];
		if (!file) return;
		const form = new FormData();
		form.append('file', file);
		setBusy(`Uploading ${file.name}…`);
		setError('');
		try {
			const a = await api.post('/assets', form);
			location.hash = `#/asset/${a.id}`;
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy('');
			e.target.value = '';
		}
	}

	async function onBlank() {
		const title = prompt('Name of the new communication', 'Hardship assistance letter');
		if (!title) return;
		setBusy('Creating…');
		try {
			const a = await api.post('/assets/blank', { title, risk: 'Medium', frequencyMonths: 12 });
			location.hash = `#/asset/${a.id}`;
		} finally {
			setBusy('');
		}
	}

	return (
		<main className="register">
			<div className="register-head">
				<div>
					<h1>Communications register</h1>
					<p className="muted">Customer-facing documents, their risk rating, and when each one is due for review. Open one to draft, review, approve and publish it without leaving the platform.</p>
				</div>
				{user.kind === 'author' && (
					<div className="register-actions">
						<button className="btn" onClick={onBlank} disabled={!!busy}>
							New from blank
						</button>
						<button className="btn primary" onClick={() => fileRef.current.click()} disabled={!!busy}>
							Upload Word or PDF
						</button>
						<input ref={fileRef} type="file" accept=".docx,.pdf,.rtf,.odt" hidden onChange={onUpload} />
					</div>
				)}
			</div>
			{busy && <div className="notice">{busy}</div>}
			{error && <div className="notice error">{error}</div>}
			{!assets ? (
				<div className="loading">Loading register…</div>
			) : assets.length === 0 ? (
				<div className="notice">The register is empty. Put Word or PDF files in <code>samples/</code> and restart the API, or use <strong>Upload Word or PDF</strong> (signed in as the owner, Alex).</div>
			) : (
				<table className="table">
					<thead>
						<tr>
							<th>Communication</th>
							<th>Format</th>
							<th>Risk</th>
							<th>Review every</th>
							<th>Stage</th>
							<th>Cycle</th>
							<th>Next review due</th>
							<th>Your access</th>
						</tr>
					</thead>
					<tbody>
						{assets.map((a) => (
							<tr key={a.id} onClick={() => (location.hash = `#/asset/${a.id}`)}>
								<td>
									<strong>{a.title}</strong>
									<div className="muted small">{a.id} · {a.sourceFile}</div>
								</td>
								<td>
									<span className={`fmt fmt-${a.format}`}>{a.format === 'word' ? 'Word' : 'PDF'}</span>
								</td>
								<td>
									<span className={`risk risk-${a.risk.toLowerCase()}`}>{a.risk}</span>
								</td>
								<td>{a.reviewFrequencyMonths} months</td>
								<td>
									<span className={`stage stage-${a.status}`}>{STAGE[a.status]}</span>
								</td>
								<td>{a.cycle}</td>
								<td>{a.status === 'published' ? fmt.date(a.nextReviewDue) : 'In progress'}</td>
								<td className="small">{accessLabel(a)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<p className="muted small footnote">
				Prototype for Skyjed. Word documents open in Nutrient Document Authoring; PDFs open in Nutrient Web SDK backed by Document Engine.
			</p>
		</main>
	);
}

export function accessLabel(a) {
	const cap = a.you.capability;
	if (cap === 'author') return a.format === 'word' ? 'Edit' : 'Edit + annotate';
	if (cap === 'approver') return a.format === 'word' && a.approvalChannel === 'word' ? 'Review (tracked changes)' : 'Annotate + comment';
	return 'View only';
}
