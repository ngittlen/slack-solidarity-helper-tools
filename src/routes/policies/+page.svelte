<script lang="ts">
	let { data } = $props();
</script>

<main class="policies">
	<nav class="toc" aria-label="Contents">
		<h2 class="toc-title">Contents</h2>
		{#each data.docs as doc (doc.slug)}
			<a class="toc-doc" href="#{doc.slug}">{doc.title}</a>
			<ul>
				{#each doc.headings as heading (heading.id)}
					<li><a href="#{heading.id}">{heading.text}</a></li>
				{/each}
			</ul>
		{/each}
	</nav>

	<div class="docs">
		<p class="lede">
			What this app records about volunteers, how long it keeps it, and how to report a security
			problem. Both documents are rendered from
			<code>PRIVACY.md</code> and <code>SECURITY.md</code> in the source repository, so what you read
			here is what a reviewer diffs.
		</p>

		{#each data.docs as doc (doc.slug)}
			<!-- Trusted by construction: `doc.html` is rendered at build time from
			     two markdown files committed to this repository, inlined into the
			     bundle by Vite's `?raw`. No request data, no database value and no
			     user input reaches it. If this page ever renders markdown from
			     app_config or from a member, it needs a sanitiser first — and the
			     disable below has to come off with it. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<article class="doc">{@html doc.html}</article>
		{/each}
	</div>
</main>

<style>
	.policies {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 32px;
		max-width: 1100px;
		margin: 0 auto;
		padding: 24px;
	}
	@media (min-width: 900px) {
		.policies {
			grid-template-columns: 220px minmax(0, 1fr);
			align-items: start;
		}
		.toc {
			position: sticky;
			top: 24px;
			max-height: calc(100vh - 48px);
			overflow-y: auto;
		}
	}

	.toc {
		font-size: var(--font-size-sm);
		line-height: 1.5;
	}
	.toc-title {
		font-family: var(--font-display);
		font-size: var(--font-size-sm);
		text-transform: uppercase;
		letter-spacing: var(--tracking-subhead);
		color: var(--color-text-faint);
		margin: 0 0 12px;
	}
	.toc-doc {
		display: block;
		font-weight: 600;
		color: var(--color-text);
		margin-top: 14px;
	}
	.toc ul {
		list-style: none;
		margin: 6px 0 0;
		padding: 0 0 0 10px;
		border-left: 1px solid var(--color-border-subtle);
	}
	.toc li {
		margin: 3px 0;
	}
	.toc a {
		color: var(--color-text-muted);
		text-decoration: none;
	}
	.toc a:hover,
	.toc a:focus-visible {
		color: var(--color-action);
		text-decoration: underline;
	}

	.lede {
		color: var(--color-text-muted);
		font-size: var(--font-size-md);
		line-height: 1.6;
		margin: 0 0 28px;
		padding-bottom: 20px;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.doc {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 28px 32px;
		margin-bottom: 28px;
		color: var(--color-text);
		font-size: var(--font-size-md);
		line-height: 1.65;
	}

	/* The document body is injected as HTML, so its elements cannot carry
	   scoped class names — hence :global. Kept inside `.doc` so nothing here
	   escapes into the rest of the app. */
	.doc :global(h2) {
		font-family: var(--font-display);
		font-size: 1.5rem;
		letter-spacing: var(--tracking-headline);
		margin: 0 0 4px;
		scroll-margin-top: 16px;
	}
	.doc :global(h3) {
		font-family: var(--font-display);
		font-size: 1.1rem;
		margin: 32px 0 8px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border-subtle);
		scroll-margin-top: 16px;
	}
	.doc :global(h4) {
		font-size: var(--font-size-lg);
		margin: 20px 0 6px;
		color: var(--color-text);
	}
	.doc :global(p) {
		margin: 0 0 14px;
	}
	.doc :global(ul),
	.doc :global(ol) {
		margin: 0 0 14px;
		padding-left: 22px;
	}
	.doc :global(li) {
		margin: 5px 0;
	}
	.doc :global(a) {
		color: var(--color-action);
	}
	.doc :global(strong) {
		color: var(--color-text);
		font-weight: 600;
	}
	.doc :global(code) {
		font-family: var(--font-mono);
		font-size: 0.9em;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
		padding: 1px 5px;
	}
	.doc :global(hr) {
		border: 0;
		border-top: 1px solid var(--color-border-subtle);
		margin: 24px 0;
	}
	/* The retention and recipients tables are wider than a phone. They scroll
	   inside their own wrapper rather than making the page scroll sideways. */
	.doc :global(table) {
		display: block;
		overflow-x: auto;
		width: 100%;
		border-collapse: collapse;
		margin: 0 0 18px;
		font-size: var(--font-size-base);
	}
	.doc :global(th),
	.doc :global(td) {
		border: 1px solid var(--color-border-subtle);
		padding: 7px 10px;
		text-align: left;
		vertical-align: top;
	}
	.doc :global(th) {
		background: var(--color-surface-alt);
		font-weight: 600;
	}
	.doc :global(blockquote) {
		margin: 0 0 14px;
		padding-left: 14px;
		border-left: 3px solid var(--color-border);
		color: var(--color-text-muted);
	}
</style>
