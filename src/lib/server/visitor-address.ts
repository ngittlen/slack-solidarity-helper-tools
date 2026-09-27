// Who a signed-out request came from, for rate limiting.
//
// Behind Fly's proxy, SvelteKit's getClientAddress() is the proxy's address,
// so every visitor would share one bucket and the first busy minute would lock
// everyone out. Fly puts the real address in Fly-Client-IP and overwrites any
// value the client sent, so on Fly that header is the answer. Off Fly the
// header is just client input and is ignored — honouring it would let anyone
// pick a fresh bucket per request.

export function visitorAddress(
	request: Request,
	getClientAddress: () => string,
	onFly: boolean,
): string {
	if (onFly) {
		const flyIp = request.headers.get('fly-client-ip')?.trim();
		if (flyIp) return flyIp;
	}
	try {
		return getClientAddress();
	} catch {
		// Some adapters and test harnesses cannot tell. One shared bucket is the
		// safe failure: it throttles harder, it never throttles less.
		return 'unknown';
	}
}
