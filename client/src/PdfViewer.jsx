import { useEffect, useRef, useState } from 'react';
import NutrientViewer from '@nutrient-sdk/viewer';
import { api } from './api.js';

// Toolbar per Skyjed capability. Permissions are enforced by Document Engine via the
// JWT; the toolbar just keeps the UI tidy for each role.
function toolbarFor(capability) {
	const defaults = NutrientViewer.defaultToolbarItems;
	const nav = ['sidebar-thumbnails', 'sidebar-annotations', 'pager', 'pan', 'zoom-out', 'zoom-in', 'zoom-mode', 'spacer', 'search'];
	if (capability === 'read') return defaults.filter((i) => [...nav, 'print'].includes(i.type));
	const hidden = ['signature', 'image', 'stamp', 'link', 'debug', 'document-crop', 'document-editor', 'export-pdf', 'sidebar-signatures', 'sidebar-attachments', 'sidebar-layers', 'sidebar-bookmarks', 'linearized-download-indicator'];
	const items = defaults.filter((i) => !hidden.includes(i.type));
	const at = items.findIndex((i) => i.type === 'spacer') + 1;
	const extra = [{ type: 'comment' }, { type: 'undo' }, { type: 'redo' }];
	if (capability === 'author') extra.push({ type: 'content-editor' });
	items.splice(at, 0, ...extra);
	return items;
}

export default function PdfViewer({ asset, config, user, onReady }) {
	const container = useRef(null);
	const [status, setStatus] = useState('Connecting to Document Engine…');
	const [session, setSession] = useState(null);
	const [viewer, setViewer] = useState(null);
	const [editingText, setEditingText] = useState(false);

	useEffect(() => {
		let instance;
		let cancelled = false;
		const el = container.current;
		(async () => {
			const s = await api.get(`/assets/${asset.id}/pdf-session`);
			// The SDK needs a sized container; wait for layout if we mounted while hidden.
			while (!cancelled && el.clientWidth === 0) await new Promise((r) => setTimeout(r, 100));
			if (cancelled) return;
			setSession(s);
			instance = await NutrientViewer.load({
				container: el,
				baseUrl: `${location.origin}/`,
				serverUrl: config.documentEngineUrl,
				documentId: s.documentId,
				authPayload: { jwt: s.jwt },
				instant: true,
				licenseKey: config.webSdkLicenseKey,
				toolbarItems: toolbarFor(s.capability),
				initialViewState: new NutrientViewer.ViewState({ sidebarMode: s.capability === 'read' ? null : NutrientViewer.SidebarMode.ANNOTATIONS }),
			});
			if (cancelled) return NutrientViewer.unload(el);
			instance.setAnnotationCreatorName(user.name);
			Object.assign(window, { viewerInstance: instance, NutrientViewer }); // handy for poking at the SDK from the console
			instance.addEventListener('viewState.change', (vs) => setEditingText(vs.interactionMode === NutrientViewer.InteractionMode.CONTENT_EDITOR));
			setViewer(instance);
			setStatus('');
			onReady?.(instance);
		})().catch((e) => setStatus(`Could not open the PDF: ${e.message}`));
		return () => {
			cancelled = true;
			setViewer(null);
			setEditingText(false);
			NutrientViewer.unload(el);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [asset.id, asset.status, asset.cycle, asset.you.capability, asset.approvalPdfId]);

	const capLabel = {
		author: 'Annotate, comment and edit page text (Content Editor)',
		approver: 'Annotate and comment at the same time as other approvers. You can change only your own markup.',
		read: 'View only',
	}[session?.capability];

	return (
		<div className="editor-wrap">
			<div className="editor-bar">
				<span className="pill">
					Web SDK + Document Engine{asset.format === 'word' ? ' · approval snapshot' : ''} · {capLabel ?? '…'}
				</span>
				{session?.capability === 'author' && viewer && !editingText && (
					<button
						className="btn primary small"
						onClick={() => viewer.setViewState((v) => v.set('interactionMode', NutrientViewer.InteractionMode.CONTENT_EDITOR))}
					>
						Edit page text
					</button>
				)}
				{editingText && <span className="pill">Editing page text: click a text block, then Save &amp; Close in the toolbar</span>}
				{session?.capability !== 'read' && session && (
					<span className="pill live">
						<span className="dot" /> Live: changes from other users sync in real time
					</span>
				)}
				{status && <span className="save-state">{status}</span>}
			</div>
			<div ref={container} className="pdf-target" />
		</div>
	);
}
