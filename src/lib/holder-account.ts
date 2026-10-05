// Which kind of account holds a turf, for the admin views that name holders.
//
// Shared rather than server-only because the pages render it: a Slack or
// Google mark before the name, and for Google the email, so an organizer can
// tell two volunteers with the same name apart and reach someone who is not in
// the Slack. Built server-side by loadHolderAccounts, and only ever put on an
// admin's payload — the email is not something volunteers see about each other.

export interface HolderAccount {
	provider: 'slack' | 'google';
	/** Google holders only, and null once an admin has cleared the stored
	 *  records (or if the read failed) — the mark still shows, the email not. */
	email: string | null;
}
