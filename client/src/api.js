export function currentUser() {
	return new URLSearchParams(location.search).get('as') ?? 'alex';
}

async function call(method, path, body) {
	const sep = path.includes('?') ? '&' : '?';
	const isForm = body instanceof FormData;
	const res = await fetch(`/api${path}${sep}as=${currentUser()}`, {
		method,
		headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, data });
	return data;
}

export const api = {
	get: (p) => call('GET', p),
	post: (p, b = {}) => call('POST', p, b),
	put: (p, b) => call('PUT', p, b),
	vaultUrl: (assetId, cycle, file) => `/api/assets/${assetId}/vault/${cycle}/${encodeURIComponent(file)}?as=${currentUser()}`,
};

export const fmt = {
	date: (iso) => (iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
	time: (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'),
	ago: (iso) => {
		const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
		return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : fmt.time(iso);
	},
};
