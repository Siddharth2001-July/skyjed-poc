import { useCallback, useEffect, useState } from 'react';
import { api, currentUser } from './api.js';
import Register from './Register.jsx';
import Workspace from './Workspace.jsx';

function useHashRoute() {
	const [hash, setHash] = useState(location.hash);
	useEffect(() => {
		const on = () => setHash(location.hash);
		addEventListener('hashchange', on);
		return () => removeEventListener('hashchange', on);
	}, []);
	const m = hash.match(/^#\/asset\/(.+)$/);
	return m ? { assetId: m[1] } : {};
}

export default function App() {
	const [config, setConfig] = useState(null);
	const { assetId } = useHashRoute();
	const userId = currentUser();

	useEffect(() => {
		api.get('/config').then(setConfig);
	}, []);

	const switchUser = useCallback((id) => {
		const url = new URL(location.href);
		url.searchParams.set('as', id);
		location.href = url.toString();
	}, []);

	if (!config) return <div className="loading">Loading…</div>;
	const user = config.users[userId];

	return (
		<div className="app">
			<header className="topbar">
				<a className="brand" href="#/">
					<span className="brand-mark">◆</span>
					<span>
						<strong>Communications Governance</strong>
						<small>Skyjed prototype · editing powered by Nutrient</small>
					</span>
				</a>
				<div className="persona">
					<span className="persona-label">Signed in as</span>
					<select value={userId} onChange={(e) => switchUser(e.target.value)}>
						{Object.values(config.users).map((u) => (
							<option key={u.id} value={u.id}>
								{u.name} · {u.title}
							</option>
						))}
					</select>
					<span className={`avatar avatar-${userId}`}>{user.name.split(' ').map((p) => p[0]).join('')}</span>
				</div>
			</header>
			{assetId ? <Workspace key={`${assetId}-${userId}`} assetId={assetId} config={config} user={user} /> : <Register config={config} user={user} />}
		</div>
	);
}
