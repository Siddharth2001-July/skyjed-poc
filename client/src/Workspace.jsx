import { useCallback, useEffect, useState } from 'react';
import { api, fmt } from './api.js';
import PdfViewer from './PdfViewer.jsx';
import { STAGE } from './Register.jsx';
import WordEditor from './WordEditor.jsx';

export default function Workspace({ assetId, config, user }) {
	const [asset, setAsset] = useState(null);
	const [tab, setTab] = useState('workflow');
	const [viewVersion, setViewVersion] = useState(null);

	const refresh = useCallback(() => api.get(`/assets/${assetId}`).then(setAsset), [assetId]);
	useEffect(() => {
		refresh();
		const t = setInterval(refresh, 2000);
		return () => clearInterval(t);
	}, [refresh]);

	if (!asset) return <div className="loading">Loading…</div>;

	// The platform picks the editor from the file type (and, for Word, the approval route).
	const usePdf = asset.format === 'pdf' || (asset.status === 'approval' && asset.approvalChannel === 'pdf');
	const u = (id) => config.users[id]?.name ?? (id === 'system' ? 'Platform (automatic)' : id);

	return (
		<main className="workspace">
			<section className="ws-main">
				<div className="ws-head">
					<a href="#/" className="back">
						← Register
					</a>
					<h2>{asset.title}</h2>
					<span className={`fmt fmt-${asset.format}`}>{asset.format === 'word' ? 'Word' : 'PDF'}</span>
					<span className={`risk risk-${asset.risk.toLowerCase()}`}>{asset.risk} risk</span>
					<Stepper asset={asset} />
				</div>
				{usePdf ? (
					<PdfViewer asset={asset} config={config} user={user} />
				) : (
					<WordEditor asset={asset} config={config} user={user} viewVersion={viewVersion} onExitVersion={() => setViewVersion(null)} onChanged={refresh} />
				)}
			</section>
			<aside className="ws-side">
				<nav className="tabs">
					{[
						['workflow', 'Workflow'],
						['summary', 'Approval summary'],
						['versions', 'Versions & vault'],
						['audit', 'Audit trail'],
					].map(([k, l]) => (
						<button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
							{l}
						</button>
					))}
				</nav>
				<div className="tab-body">
					{tab === 'workflow' && <WorkflowPanel asset={asset} config={config} user={user} onUpdate={setAsset} u={u} />}
					{tab === 'summary' && <SummaryPanel asset={asset} u={u} />}
					{tab === 'versions' && <VersionsPanel asset={asset} u={u} onView={(v) => setViewVersion(v)} usePdf={usePdf} />}
					{tab === 'audit' && <AuditPanel asset={asset} u={u} />}
				</div>
			</aside>
		</main>
	);
}

function Stepper({ asset }) {
	const steps = ['draft', 'approval', 'published'];
	const idx = steps.indexOf(asset.status);
	return (
		<ol className="stepper">
			{steps.map((s, i) => (
				<li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''}>
					{STAGE[s]}
				</li>
			))}
			<li className="cycle">Cycle {asset.cycle}</li>
		</ol>
	);
}

function WorkflowPanel({ asset, config, user, onUpdate, u }) {
	const [busy, setBusy] = useState('');
	const [note, setNote] = useState('');
	const [channel, setChannel] = useState('word');
	const [error, setError] = useState('');
	const cap = asset.you.capability;

	const act = (label, path, body) => async () => {
		setBusy(label);
		setError('');
		try {
			onUpdate(await api.post(`/assets/${asset.id}/${path}`, body));
			setNote('');
		} catch (e) {
			setError(e.message);
		} finally {
			setBusy('');
		}
	};

	return (
		<div className="panel">
			<div className="card">
				<h4>Your access at this stage</h4>
				<p>
					<strong>{user.name}</strong> · {user.title}
				</p>
				<p className="muted">{explain(asset, cap)}</p>
			</div>

			{asset.status === 'draft' && (
				<div className="card">
					<h4>Draft</h4>
					<p className="muted">Owner: {u(asset.owner)}. Approvers: {asset.approvers.map(u).join(', ')} (parallel).</p>
					{asset.feedback.length > 0 && (
						<div className="feedback">
							<strong>Changes requested</strong>
							{asset.feedback.map((f, i) => (
								<p key={i}>
									<em>{u(f.by)}:</em> {f.note}
								</p>
							))}
						</div>
					)}
					{cap === 'author' && (
						<>
							{asset.format === 'word' && (
								<div className="choice">
									<label>
										<input type="radio" checked={channel === 'word'} onChange={() => setChannel('word')} /> Approvers review in Word: tracked changes, one writer at a time, others follow live
									</label>
									<label>
										<input type="radio" checked={channel === 'pdf'} onChange={() => setChannel('pdf')} /> Approvers mark up a PDF snapshot: everyone at the same time
									</label>
								</div>
							)}
							<button className="btn primary block" disabled={!!busy} onClick={act('Submitting…', 'submit', { channel })}>
								Submit for approval
							</button>
						</>
					)}
				</div>
			)}

			{asset.status === 'approval' && (
				<div className="card">
					<h4>Parallel approval</h4>
					<ul className="approvals">
						{asset.approvers.map((id) => {
							const a = asset.approvals[id];
							return (
								<li key={id} className={a ? a.decision : 'pending'}>
									<span>{u(id)}</span>
									<span>{a ? (a.decision === 'approve' ? `Approved ${fmt.ago(a.at)}` : 'Changes requested') : 'Pending'}</span>
								</li>
							);
						})}
					</ul>
					{cap === 'approver' && (
						<>
							<textarea placeholder="Note for the approval record (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
							<div className="row">
								<button className="btn primary" disabled={!!busy} onClick={act('Approving…', 'decision', { decision: 'approve', note })}>
									Approve
								</button>
								<button className="btn" disabled={!!busy} onClick={act('Sending back…', 'decision', { decision: 'changes', note })}>
									Request changes
								</button>
							</div>
						</>
					)}
					<p className="muted small">When the last approver approves, the platform publishes automatically: it accepts all changes, moves comments into the approval summary, and writes a clean copy to the vault.</p>
				</div>
			)}

			{asset.status === 'published' && (
				<div className="card">
					<h4>Published · cycle {asset.cycle}</h4>
					<p>
						Next review due <strong>{fmt.date(asset.nextReviewDue)}</strong> ({asset.reviewFrequencyMonths}-month cycle, {asset.risk.toLowerCase()} risk).
					</p>
					<VaultLinks asset={asset} record={asset.cycles[0]} />
					{cap === 'read' && asset.owner === user.id && (
						<button className="btn primary block" disabled={!!busy} onClick={act('Starting…', 'next-cycle')}>
							Start next review (cycle {asset.cycle + 1})
						</button>
					)}
				</div>
			)}
			{busy && <div className="notice">{busy}</div>}
			{error && <div className="notice error">{error}</div>}
		</div>
	);
}

function explain(asset, cap) {
	const word = asset.format === 'word' && !(asset.status === 'approval' && asset.approvalChannel === 'pdf');
	if (cap === 'author')
		return word
			? 'Full editing. Take the pen to edit; changes autosave as new versions. You can accept or reject tracked changes while drafting.'
			: 'Annotate and comment, and edit page text with the Content Editor. Annotations sync instantly.';
	if (cap === 'approver')
		return word
			? 'Review mode: everything you type becomes a tracked change under your name. You can add comments. You cannot accept or reject changes. That happens automatically when everyone has approved.'
			: 'Mark up and comment at the same time as the other approvers. You can change only your own markup. Page text is locked.';
	if (asset.status === 'approval') return 'Read-only during approval. Only the assigned approvers can mark up the document.';
	if (asset.status === 'published') return 'Published. The approved version is in the vault and can no longer be changed.';
	return 'Read-only. Only the owner edits during drafting.';
}

function VaultLinks({ asset, record }) {
	if (!record) return null;
	const labels = { docx: 'Clean Word (.docx)', pdf: 'Clean PDF', reviewedPdf: 'Approval mark-up record (PDF)', summary: 'Approval summary (JSON)' };
	return (
		<ul className="vault">
			{Object.entries(record.files).map(([k, f]) => (
				<li key={k}>
					<a href={api.vaultUrl(asset.id, record.cycle, f)} target="_blank" rel="noreferrer">
						🔒 {labels[k] ?? f}
					</a>
				</li>
			))}
		</ul>
	);
}

function SummaryPanel({ asset, u }) {
	const published = asset.status === 'published' && asset.cycles[0];
	const [live, setLive] = useState(null);
	const [loading, setLoading] = useState(false);
	const load = useCallback(() => {
		setLoading(true);
		api.get(`/assets/${asset.id}/review`).then(setLive).finally(() => setLoading(false));
	}, [asset.id]);
	useEffect(() => {
		if (!published) load();
	}, [published, load]);

	const data = published ? published.summary : live;
	return (
		<div className="panel">
			<p className="muted small">
				{published
					? `Recorded when cycle ${published.cycle} was published (${fmt.time(published.publishedAt)}). These were removed from the clean copy.`
					: 'Live preview: what the platform will move into the approval summary when this is published.'}{' '}
				{!published && (
					<button className="link" onClick={load} disabled={loading}>
						{loading ? 'Refreshing…' : 'Refresh'}
					</button>
				)}
			</p>
			{!data ? (
				<div className="loading">Reading review data…</div>
			) : (
				<>
					{published?.approvals && (
						<Section title="Approvals">
							{Object.entries(published.approvals).map(([id, a]) => (
								<Item key={id} who={u(id)} at={a.at} text={`${a.decision === 'approve' ? 'Approved' : 'Requested changes'}${a.note ? `: ${a.note}` : ''}`} />
							))}
						</Section>
					)}
					{asset.format === 'word' && (
						<>
							<Section title={`Tracked changes (${data.revisions?.length ?? 0})`} empty="No tracked changes.">
								{data.revisions?.map((r) => (
									<Item key={r.id} who={r.author} at={r.date} tag={r.type} text={r.preview || '(formatting or structural change)'} />
								))}
							</Section>
							<Section title={`Comments (${data.comments?.length ?? 0})`} empty="No comments.">
								{data.comments?.map((c) => (
									<Item key={c.id} who={c.author} at={c.createdAt} quote={c.anchorText} text={c.text} replies={c.replies} />
								))}
							</Section>
						</>
					)}
					{(asset.format === 'pdf' || data.pdfMarkups?.length > 0) && (
						<Section title={`PDF markups (${data.pdfMarkups?.length ?? 0})`} empty="No markups.">
							{data.pdfMarkups?.map((m) => (
								<Item key={m.id} who={m.author} at={m.createdAt} tag={`${m.type} · p${m.page}`} text={m.text} replies={m.comments} />
							))}
						</Section>
					)}
					{data.feedback?.length > 0 && (
						<Section title="Approver notes">
							{data.feedback.map((f, i) => (
								<Item key={i} who={u(f.by)} at={f.at} text={f.note} />
							))}
						</Section>
					)}
				</>
			)}
		</div>
	);
}

function Section({ title, empty, children }) {
	const has = Array.isArray(children) ? children.length > 0 : !!children;
	return (
		<div className="section">
			<h5>{title}</h5>
			{has ? children : <p className="muted small">{empty}</p>}
		</div>
	);
}

function Item({ who, at, tag, quote, text, replies }) {
	return (
		<div className="item">
			<div className="item-head">
				<strong>{who ?? 'Unknown'}</strong>
				{tag && <span className="tag">{tag}</span>}
				<span className="muted small">{fmt.time(at)}</span>
			</div>
			{quote && <blockquote>“{quote}”</blockquote>}
			{text && <p>{text}</p>}
			{replies?.map((r, i) => (
				<p key={i} className="reply">
					↳ <strong>{r.author}</strong>: {r.text}
				</p>
			))}
		</div>
	);
}

function VersionsPanel({ asset, u, onView, usePdf }) {
	return (
		<div className="panel">
			{asset.format === 'word' && (
				<div className="section">
					<h5>Working copy history</h5>
					<p className="muted small">Every autosave is a new version. Earlier cycles stay available.</p>
					<ul className="versions">
						{asset.word.versions.map((v) => (
							<li key={`${v.cycle}-${v.version}`}>
								<span>
									<strong>v{v.version}</strong> · cycle {v.cycle} · {u(v.by)}
									<br />
									<span className="muted small">
										{v.note} · {fmt.time(v.at)}
									</span>
								</span>
								{!usePdf && (
									<button className="btn small" onClick={() => onView({ version: v.version, cycle: v.cycle })}>
										View
									</button>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
			{asset.format === 'pdf' && (
				<div className="section">
					<h5>Working copy</h5>
					<p className="muted small">
						Held in Document Engine (document {asset.pdf.documentId}). Annotations and content edits persist as they happen. There's no save button.
						{asset.pdf.previousDocumentIds?.length ? ` Earlier cycles: ${asset.pdf.previousDocumentIds.join(', ')}.` : ''}
					</p>
				</div>
			)}
			<div className="section">
				<h5>Vault: published versions (write once, read many)</h5>
				{asset.cycles.length === 0 && <p className="muted small">Nothing published yet.</p>}
				{asset.cycles.map((c) => (
					<div key={c.cycle} className="item">
						<div className="item-head">
							<strong>Cycle {c.cycle}</strong>
							<span className="muted small">{fmt.time(c.publishedAt)}</span>
						</div>
						<VaultLinks asset={asset} record={c} />
					</div>
				))}
			</div>
		</div>
	);
}

function AuditPanel({ asset, u }) {
	return (
		<div className="panel">
			<ul className="audit">
				{asset.audit.map((e, i) => (
					<li key={i}>
						<span className="muted small">
							{fmt.time(e.at)} · cycle {e.cycle}
						</span>
						<span>
							<strong>{u(e.user)}</strong> {e.action.toLowerCase()}
						</span>
						{e.detail && <span className="muted small">{e.detail}</span>}
					</li>
				))}
			</ul>
		</div>
	);
}
