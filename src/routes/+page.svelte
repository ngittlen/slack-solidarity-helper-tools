<script lang="ts">
    import { resolve } from '$app/paths';
    const { data: pageData }: { data: { userName: string; isAdmin: boolean } } = $props();
</script>

<svelte:head>
    <title>Dashboard</title>
</svelte:head>

<main>
    <h1>Hi, {pageData.userName}</h1>
    <p>The full dashboard is coming soon.</p>
    {#if pageData.isAdmin}
        <p><a href={resolve('/pending')}>Pending applicants</a></p>
    {/if}
    <form method="POST" action="/auth/logout">
        <button type="submit">Sign out</button>
    </form>
</main>

<style>
    main {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        max-width: 640px;
        margin: 0 auto;
        padding: 2rem 1.5rem;
    }
</style>
