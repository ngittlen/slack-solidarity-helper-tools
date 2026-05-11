<script lang="ts">
    import {onMount} from 'svelte';
    import './pending.css';
    import { parsePhoneNumberWithError } from 'libphonenumber-js';

    const {data: pageData} = $props();

    interface Entry {
        id: number;
        email: string | null;
        name: string | null;
        phone: string | null;
        comment: string | null;
        in_slack: boolean;
        status: string;
        lastEditedById: string | null;
        lastEditedByName: string | null;
    }

    const STATUS_OPTIONS = [
        { value: 'uncontacted', label: 'Uncontacted' },
        { value: 'contacted', label: 'Contacted' },
        { value: 'verified_in_slack', label: 'In Slack' },
    ] as const;

    const STATUS_ORDER: Record<string, number> = { uncontacted: 0, contacted: 1, verified_in_slack: 2 };

    interface ApiResponse {
        pending: Entry[];
        total_requested: number;
        total_pending: number;
    }

    type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

    let loading = $state(true);
    let errorMessage = $state<string | null>(null);
    let data = $state<ApiResponse | null>(null);
    let sseConnected = $state(true);

    let comments = $state<Record<number, string>>({});
    let saveStatuses = $state<Record<number, SaveStatus>>({});
    let statusState = $state<Record<number, string>>({});
    let lastEditedByState = $state<Record<number, string | null>>({});

    const saveTimers: Record<number, ReturnType<typeof setTimeout>> = {};

    let totalPending = $derived(
        data ? data.pending.filter((e) => (statusState[e.id] ?? e.status) !== 'verified_in_slack').length : 0
    );

    let sortedEntries = $derived(
        data
            ? [...data.pending].sort((a, b) => {
                const aOrder = STATUS_ORDER[statusState[a.id] ?? a.status] ?? 0;
                const bOrder = STATUS_ORDER[statusState[b.id] ?? b.status] ?? 0;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return (a.email ?? '').localeCompare(b.email ?? '');
            })
            : []
    );

    async function fetchPending() {
        loading = true;
        errorMessage = null;
        try {
            const res = await fetch('/api/pending');
            if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
            const json: ApiResponse = await res.json();
            data = json;
            comments = Object.fromEntries(json.pending.map((e) => [e.id, e.comment ?? '']));
            statusState = Object.fromEntries(json.pending.map((e) => [e.id, e.status]));
            lastEditedByState = Object.fromEntries(json.pending.map((e) => [e.id, e.lastEditedByName]));
        } catch (err) {
            errorMessage = err instanceof Error ? err.message : 'Unknown error';
        } finally {
            loading = false;
        }
    }

    async function saveComment(id: number) {
        saveStatuses[id] = 'saving';
        try {
            const res = await fetch('/api/comment', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id, comment: comments[id] ?? ''})
            });
            if (!res.ok) throw new Error(`Save failed: ${res.status}`);
            saveStatuses[id] = 'saved';
            lastEditedByState[id] = pageData.userName ?? null;
            setTimeout(() => {
                saveStatuses[id] = 'idle';
            }, 2000);
        } catch (err) {
            console.error('[saveComment]', err);
            saveStatuses[id] = 'error';
        }
    }

    function onCommentInput(id: number) {
        saveStatuses[id] = 'pending';
        clearTimeout(saveTimers[id]);
        saveTimers[id] = setTimeout(() => saveComment(id), 600);
    }

    async function setStatus(id: number, status: string) {
        statusState[id] = status;
        lastEditedByState[id] = pageData.userName ?? null;
        await fetch('/api/helped', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({id, status})
        });
    }

    let copyLabel = $state('Copy uncontacted emails');
    let hasUncontactedEmails = $derived(
        data ? data.pending.some((e) => (statusState[e.id] ?? e.status) === 'uncontacted' && e.email) : false
    );

    async function copyUncontactedEmails() {
        if (!data) return;
        const emails = data.pending
            .filter((e) => (statusState[e.id] ?? e.status) === 'uncontacted' && e.email)
            .map((e) => e.email as string)
            .join(', ');
        await navigator.clipboard.writeText(emails);
        copyLabel = 'Copied!';
        setTimeout(() => { copyLabel = 'Copy uncontacted emails'; }, 2000);
    }

    function formatPhone(phone: string): string {
        try {
            const parsed = parsePhoneNumberWithError(phone, 'US');
            return parsed.formatNational();
        } catch {
            return phone;
        }
    }

    onMount(() => {
        fetchPending();

        const es = new EventSource('/api/events');

        es.onopen = () => { sseConnected = true; };

        es.onerror = () => {
            sseConnected = es.readyState !== EventSource.CLOSED;
        };

        es.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'new-request') {
                    if (data) {
                        data.pending = [...data.pending, {
                            id: msg.id,
                            email: msg.email,
                            name: msg.name,
                            phone: msg.phone,
                            comment: null,
                            in_slack: false,
                            status: 'uncontacted',
                            lastEditedById: null,
                            lastEditedByName: null,
                        }];
                        data.total_requested += 1;
                        comments[msg.id] = '';
                        statusState[msg.id] = 'uncontacted';
                        lastEditedByState[msg.id] = null;
                    }
                } else if (msg.type === 'status') {
                    statusState[msg.id] = msg.status;
                    lastEditedByState[msg.id] = msg.editedBy;
                } else if (msg.type === 'comment') {
                    // Don't overwrite a textarea the current user is actively editing
                    const status = saveStatuses[msg.id] ?? 'idle';
                    if (status === 'idle') {
                        comments[msg.id] = msg.comment ?? '';
                        lastEditedByState[msg.id] = msg.editedBy;
                    }
                }
            } catch (err) {
                console.warn('[events] malformed SSE message:', e.data, err);
            }
        };
        return () => es.close();
    });
</script>

<svelte:head>
    <title>A4M Slack Invite Queue</title>
</svelte:head>

<main>
    {#if loading}
        <p class="status">Loading...</p>
    {:else if errorMessage}
        <p class="error">{errorMessage}</p>
    {:else if data}
        {#if !sseConnected}
            <p class="sse-error">Live updates disconnected — changes from other users won't appear until you reload.</p>
        {/if}

        <div class="toolbar">
            <div class="stats">
                <div class="stat">
                    <span class="stat-value">{totalPending}</span>
                    <span class="stat-label">Pending</span>
                </div>
                <div class="stat">
                    <span class="stat-value">{data.total_requested}</span>
                    <span class="stat-label">Total requested</span>
                </div>
            </div>
            <button onclick={copyUncontactedEmails} disabled={!hasUncontactedEmails} title={!hasUncontactedEmails ? 'There are no uncontacted people' : undefined}>{copyLabel}</button>
        </div>

        {#if data.pending.length === 0}
            <p class="empty">No pending invites.</p>
        {:else}
            <div class="table-wrap">
                <table>
                    <thead>
                    <tr>
                        <th class="col-helped"></th>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Phone</th>
                        <th>Comment</th>
                        <th>Last edited by</th>
                    </tr>
                    </thead>
                    <tbody>
                    {#each sortedEntries as entry (entry.id)}
                        {@const currentStatus = statusState[entry.id] ?? entry.status}
                        <tr class:helped={currentStatus === 'verified_in_slack'} class:contacted={currentStatus === 'contacted'}>
                            <td class="col-helped">
                                <select
                                        onchange={(e) => setStatus(entry.id, (e.target as HTMLSelectElement).value)}
                                        aria-label="Status for {entry.name ?? entry.email ?? entry.phone ?? 'volunteer'}"
                                >
                                    {#each STATUS_OPTIONS as opt (opt.value)}
                                        <option value={opt.value} selected={opt.value === currentStatus}>{opt.label}</option>
                                    {/each}
                                </select>
                            </td>
                            <td class="col-name">
                                {entry.name ?? '—'}
                                {#if entry.in_slack}
                                    <span class="in-slack-badge">Email in slack</span>
                                {/if}
                            </td>
                            <td class="col-email">
                                {#if entry.email}
                                    <a href="mailto:{entry.email}">{entry.email}</a>
                                {:else}
                                    —
                                {/if}
                            </td>
                            <td class="col-phone">
                                {#if entry.phone}
                                    <a href="tel:{entry.phone}">{formatPhone(entry.phone)}</a>
                                {:else}
                                    —
                                {/if}
                            </td>
                            <td class="col-comment">
									<textarea
                                            rows="1"
                                            placeholder="Add a comment..."
                                            aria-label="Comment for {entry.name ?? entry.email ?? entry.phone ?? 'volunteer'}"
                                            bind:value={comments[entry.id]}
                                            oninput={() => onCommentInput(entry.id)}
                                            class:unsaved={saveStatuses[entry.id] === 'pending' || saveStatuses[entry.id] === 'saving'}
                                            class:saved={saveStatuses[entry.id] === 'saved'}
                                    ></textarea>
                                {#if saveStatuses[entry.id] === 'saving'}
                                    <span class="comment-status">Saving...</span>
                                {:else if saveStatuses[entry.id] === 'saved'}
                                    <span class="comment-status saved">Saved</span>
                                {:else if saveStatuses[entry.id] === 'error'}
                                    <span class="comment-status error">Error saving</span>
                                {/if}
                            </td>
                            <td class="col-edited-by">
                                {lastEditedByState[entry.id] ?? '—'}
                            </td>
                        </tr>
                    {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    {/if}
</main>