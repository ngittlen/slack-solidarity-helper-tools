<script lang="ts">
	// Asked once of a new canvasser on /turfs (specs/015-mentor-walks,
	// User Story 3, FR-014). "Not now" brings it back in 7 days. Someone no
	// walk suits yet can ask for alerts instead (User Story 7).

	import './mentor-walks.css';

	interface Props {
		onyes: () => void;
		onsnooze: () => void;
		ondecline: () => void;
		onalerts: () => void;
	}

	let { onyes, onsnooze, ondecline, onalerts }: Props = $props();
</script>

<!-- Kept short: it sits at the top of the turf list. -->
<section class="mw-panel mw-prompt newbie" aria-labelledby="mw-newbie-heading">
	<div class="newbie-text">
		<h2 id="mw-newbie-heading">
			<span aria-hidden="true">👟</span> Want to go out with an experienced canvasser near you?
		</h2>
		<p class="mw-muted">
			Mentors post when and where they're heading out next. Your first time is easier with company.
		</p>
	</div>
	<div class="mw-actions">
		<button type="button" class="mw-btn mw-btn-primary" onclick={onyes}>Yes, show me</button>
		<button type="button" class="mw-btn mw-btn-ghost" onclick={onsnooze}>Not now</button>
		<button type="button" class="mw-btn mw-btn-link" onclick={ondecline}>No thanks</button>
	</div>
	<p class="newbie-alerts">
		<button type="button" class="mw-btn mw-btn-link" onclick={onalerts}>
			Tell me when a mentor plans a walk near me
		</button>
	</p>
</section>

<style>
	.newbie {
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
	}

	.newbie-text {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.newbie-alerts {
		font-size: var(--font-size-sm);
	}
</style>
