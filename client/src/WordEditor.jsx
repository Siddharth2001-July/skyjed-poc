import { useEffect, useRef, useState } from 'react';
import DocAuth, { defaultToolbarConfig } from '@nutrient-sdk/document-authoring';
import { api, fmt } from './api.js';

let systemPromise = null;
function docAuthSystem(licenseKey) {
	systemPromise ??= DocAuth.createDocAuthSystem(licenseKey ? { licenseKey } : {});
	return systemPromise;
}

// The platform decides edit / review / view from the user's role and stage, so the
// built-in mode switcher is removed: users must not be able to change it themselves.
const TOOLBAR = { ...defaultToolbarConfig, items: defaultToolbarConfig.items.filter((i) => i.builtInType !== 'editor-mode') };

const IDLE_RELEASE_MS = 20_000; // hand the pen back automatically when you stop typing
const AUTOSAVE_DEBOUNCE_MS = 1200;

// Skyjed role → Document Authoring editor mode + participant role.
const MODES = {
	author: { mode: 'edit', role: 'owner', label: 'Edit' },
	approver: { mode: 'review', role: 'reviewer', label: 'Review (your edits become tracked changes)' },
	read: { mode: 'view', role: 'reader', label: 'View only' },
};

export default function WordEditor({ asset, config, user, viewVersion, onExitVersion, onChanged }) {
	const target = useRef(null);
	const editorRef = useRef(null);
	const loadedVersion = useRef(0);
	const holding = useRef(false);
	const saving = useRef(Promise.resolve());
	const timers = useRef({});
	const [pen, setPen] = useState({ holding: false, error: '' });
	const [saveState, setSaveState] = useState({ text: '', at: null });

	const cap = asset.you.capability;
	const { mode, role, label } = MODES[cap];
	const canWrite = cap !== 'read' && !viewVersion;
	const otherHolder = asset.word.penHolder && asset.word.penHolder !== user.id ? asset.word.penHolder : null;

	async function loadDoc(version, cycle) {
		const sys = await docAuthSystem(config.docAuthLicenseKey);
		const q = version ? `?version=${version}${cycle ? `&cycle=${cycle}` : ''}` : '';
		const { docJson, version: v } = await api.get(`/assets/${asset.id}/word${q}`);
		const doc = await sys.loadDocument(docJson, { participant: { author: user.name, role: viewVersion ? 'reader' : role } });
		return { doc, version: v };
	}

	// Create the editor once per asset/stage/version being viewed.
	useEffect(() => {
		let cancelled = false;
		let editor;
		// A stage change (submit, approve, new cycle) ends any editing session.
		if (holding.current) stopHolding();
		(async () => {
			const sys = await docAuthSystem(config.docAuthLicenseKey);
			const { doc, version } = await loadDoc(viewVersion?.version, viewVersion?.cycle);
			if (cancelled) return;
			editor = await sys.createEditor(target.current, { document: doc, ui: { author: user.name, toolbar: TOOLBAR } });
			editor.setAuthor(user.name);
			editor.setEditorMode(holding.current ? mode : 'view');
			loadedVersion.current = version;
			editorRef.current = editor;
			editor.on('content.change', onContentChange);
		})().catch((e) => setPen((p) => ({ ...p, error: e.message })));
		return () => {
			cancelled = true;
			clearTimeout(timers.current.save);
			editor?.destroy();
			editorRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [asset.id, asset.status, asset.cycle, cap, viewVersion?.version]);

	// Follow live: if someone else saved a newer version, swap it in.
	useEffect(() => {
		if (viewVersion || holding.current || !editorRef.current) return;
		if (asset.word.version > loadedVersion.current) {
			loadDoc().then(({ doc, version }) => {
				if (!editorRef.current || holding.current) return;
				editorRef.current.setCurrentDocument(doc);
				editorRef.current.setEditorMode('view');
				loadedVersion.current = version;
				setSaveState({ text: `Updated to v${version}`, at: new Date().toISOString() });
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [asset.word.version]);

	// Release the pen when leaving the page.
	useEffect(() => () => holding.current && release(), []); // eslint-disable-line react-hooks/exhaustive-deps

	function onContentChange() {
		if (!holding.current) return;
		setSaveState({ text: 'Unsaved changes…', at: null });
		clearTimeout(timers.current.save);
		timers.current.save = setTimeout(saveNow, AUTOSAVE_DEBOUNCE_MS);
		clearTimeout(timers.current.idle);
		timers.current.idle = setTimeout(() => release(), IDLE_RELEASE_MS);
	}

	function saveNow() {
		saving.current = saving.current.then(async () => {
			const editor = editorRef.current;
			if (!editor || !holding.current) return;
			setSaveState({ text: 'Saving…', at: null });
			try {
				const docJson = await editor.currentDocument().saveDocument();
				const { version } = await api.put(`/assets/${asset.id}/word`, { docJson, baseVersion: loadedVersion.current });
				loadedVersion.current = version;
				setSaveState({ text: `Saved as v${version}`, at: new Date().toISOString() });
				onChanged?.();
			} catch (e) {
				setSaveState({ text: e.status === 409 ? 'Someone saved a newer version. Reloading…' : `Not saved: ${e.message}`, at: null });
				if (e.status === 409 || e.status === 423) await stopHolding();
			}
		});
		return saving.current;
	}

	async function take() {
		setPen({ holding: false, error: '' });
		try {
			const r = await api.post(`/assets/${asset.id}/pen`, { action: 'take' });
			if (r.version > loadedVersion.current) {
				const { doc, version } = await loadDoc();
				editorRef.current.setCurrentDocument(doc);
				loadedVersion.current = version;
			}
			holding.current = true;
			editorRef.current.setEditorMode(mode);
			setPen({ holding: true, error: '' });
			timers.current.heartbeat = setInterval(() => api.post(`/assets/${asset.id}/pen`, { action: 'heartbeat' }).catch(() => {}), 5000);
			timers.current.idle = setTimeout(() => release(), IDLE_RELEASE_MS);
			onChanged?.();
		} catch (e) {
			setPen({ holding: false, error: e.message });
		}
	}

	async function stopHolding() {
		holding.current = false;
		clearInterval(timers.current.heartbeat);
		clearTimeout(timers.current.idle);
		editorRef.current?.setEditorMode('view');
		setPen({ holding: false, error: '' });
	}

	async function release() {
		clearTimeout(timers.current.save);
		await saveNow();
		await stopHolding();
		await api.post(`/assets/${asset.id}/pen`, { action: 'release' }).catch(() => {});
		onChanged?.();
	}

	return (
		<div className="editor-wrap">
			<div className="editor-bar">
				{viewVersion ? (
					<>
						<span className="pill">Viewing v{viewVersion.version} (cycle {viewVersion.cycle}), read-only</span>
						<button className="btn small" onClick={onExitVersion}>
							Back to latest
						</button>
					</>
				) : (
					<>
						<span className="pill">Document Authoring · {pen.holding ? label : canWrite ? 'View (take the pen to edit)' : label}</span>
						{canWrite && !pen.holding && !otherHolder && (
							<button className="btn primary small" onClick={take}>
								{cap === 'approver' ? 'Start reviewing' : 'Start editing'}
							</button>
						)}
						{pen.holding && (
							<button className="btn small" onClick={release}>
								Done, hand back the pen
							</button>
						)}
						{otherHolder && (
							<span className="pill live">
								<span className="dot" /> {config.users[otherHolder].name} is {asset.status === 'approval' ? 'reviewing' : 'editing'}. You're following live.
							</span>
						)}
						<span className="save-state">
							{saveState.text}
							{saveState.at && ` · ${fmt.ago(saveState.at)}`}
						</span>
					</>
				)}
				{pen.error && <span className="error-text">{pen.error}</span>}
			</div>
			<div ref={target} className="docauth-target" />
		</div>
	);
}
