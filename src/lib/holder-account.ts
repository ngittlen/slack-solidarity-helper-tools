// Which kind of account holds a turf, for the admin views that name holders.
//
// Shared rather than server-only because the pages render it: a Slack, Google
// or Apple mark before the name, and for the latter two the email, so an organizer can
// tell two volunteers with the same name apart and reach someone who is not in
// the Slack. Built server-side by loadHolderAccounts, and only ever put on an
// admin's payload — the email is not something volunteers see about each other.

export interface HolderAccount {
	provider: 'slack' | 'google' | 'apple';
	/** Google and Apple holders only (an Apple one may be a Hide My Email relay
	 *  address), and null once an admin has cleared the stored
	 *  records (or if the read failed) — the mark still shows, the email not. */
	email: string | null;
	/** True when `email` is an Apple Hide My Email relay address: it tells two
	 *  volunteers apart, but mail from an organizer's own account won't reach
	 *  it, so the page says so (FR-015 of specs/014-apple-sso-login). */
	isPrivateEmail: boolean;
}
