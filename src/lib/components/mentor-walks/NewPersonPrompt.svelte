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

<section class="mw-panel mw-prompt" aria-labelledby="mw-newbie-heading">
	<h2 id="mw-newbie-heading">Want to go out with an experienced canvasser near you?</h2>
	<p>
		Mentors post when and where they're heading out next. Take a seat, meet them at a public spot,
		and knock doors together. Your first time is easier with company.
	</p>
	<div class="mw-actions">
		<button type="button" class="mw-btn mw-btn-primary" onclick={onyes}>Yes, show me</button>
		<button type="button" class="mw-btn mw-btn-ghost" onclick={onsnooze}>Not now</button>
		<button type="button" class="mw-btn mw-btn-link" onclick={ondecline}>No thanks</button>
	</div>
	<p>
		<button type="button" class="mw-btn mw-btn-link" onclick={onalerts}>
			Tell me when a mentor plans a walk near me
		</button>
	</p>
</section>
