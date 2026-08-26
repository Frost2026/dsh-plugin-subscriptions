import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Subscriptions settings section: one card per subscription provider with an
 * OAuth login/logout flow driven by the node half's `/subscriptions-auth` RPC
 * channel. Login state lives server-side; the page polls `status` only while
 * a login attempt is busy, so an idle page never polls. All state is local
 * React state — the page has no store.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and
 * every user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace. Buttons and inputs take the
 * ModelsSection vocabulary minus hover rules, which inline styles cannot
 * express.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { en } from './locales.js';
/** Logical RPC channel served by the node half of this plugin. */
const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth';
/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000;
/**
 * Model count above which the expanded default-effort list also offers a name
 * filter; below it the list is short enough to scan.
 */
const MODEL_FILTER_THRESHOLD = 8;
/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS = [
    { id: 'codex', name: 'Codex (ChatGPT)' },
    { id: 'claude', name: 'Claude' },
    { id: 'grok', name: 'Grok (X Premium)' },
    { id: 'copilot', name: 'GitHub Copilot' },
];
/** Business error returned by the `/subscriptions-auth` channel (error branch message). */
class SubscriptionsAuthError extends Error {
}
/**
 * Call one `/subscriptions-auth` endpoint and unwrap the business result.
 * Shared by the settings section and the composer Speed toggle.
 * @param rpc - Connection RPC caller.
 * @param endpoint - channel-relative endpoint.
 * @param payload - channel-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
export async function callSubscriptionsAuth(rpc, endpoint, payload) {
    let result;
    try {
        result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, endpoint, payload);
    }
    catch (error) {
        // The transport rejected rather than answering; surface the same way.
        throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error));
    }
    if (!result.ok)
        throw new SubscriptionsAuthError(result.error.message);
    return result.value;
}
/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key, params) {
    let text = en[key];
    for (const [name, value] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
}
const styles = {
    section: {
        display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560,
        color: 'var(--dsw-alias-label-primary)',
    },
    intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
    card: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
    },
    proxyCard: {
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
    },
    separator: { borderTop: '1px solid var(--dsw-alias-border-l2)' },
    cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
    dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
    name: { fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
    statusLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
    errorLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
    actions: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
    button: {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 28, padding: '0 10px', borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
        cursor: 'pointer',
    },
    usage: {
        display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
        borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8,
    },
    usageHeader: { display: 'flex', alignItems: 'center', gap: 8 },
    usageTitle: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
    usagePlan: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
    usageRefresh: {
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 22, padding: '0 8px', borderRadius: 11, marginLeft: 'auto',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
        cursor: 'pointer',
    },
    usageRow: { display: 'flex', flexDirection: 'column', gap: 3 },
    usageMeta: {
        display: 'flex', justifyContent: 'space-between', gap: 8,
        fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
    },
    usageTrack: {
        height: 6, borderRadius: 3, overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
    },
    usageFill: { height: '100%', borderRadius: 3 },
    defaultEffort: {
        display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
        borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8,
    },
    /** The always-visible disclosure header: title, summary, chevron. */
    defaultEffortToggle: {
        boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: 0, border: 'none', background: 'transparent',
        font: 'inherit', textAlign: 'left', cursor: 'pointer',
    },
    defaultEffortChevron: {
        marginLeft: 'auto', flexShrink: 0, fontSize: 10, lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
    },
    /** Body of the expanded disclosure: bounded height so a long catalog scrolls. */
    defaultEffortList: {
        display: 'flex', flexDirection: 'column', gap: 6,
        maxHeight: 260, overflowY: 'auto', paddingRight: 2,
    },
    defaultEffortRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    defaultEffortName: {
        fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    },
    defaultEffortSelect: {
        maxWidth: 220, flexShrink: 0, height: 28, boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        padding: '0 8px', font: 'inherit', fontSize: 12, lineHeight: '18px',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    },
    defaultEffortFilter: {
        height: 28, width: '100%', boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        padding: '0 8px', font: 'inherit', fontSize: 12, lineHeight: '18px',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    },
    manual: { marginTop: 4, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
    manualRow: { display: 'flex', gap: 8, marginTop: 6 },
    manualInput: {
        flex: 1, height: 32, boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    },
    deviceCode: {
        marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6,
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)',
    },
    deviceCodeText: {
        fontFamily: 'monospace', fontSize: 18, lineHeight: '24px', letterSpacing: 2,
        color: 'var(--dsw-alias-label-primary)', userSelect: 'all',
    },
    proxyField: { display: 'flex', flexDirection: 'column', gap: 4 },
    proxyLabel: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
    proxyInput: {
        height: 32, width: '100%', boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    },
    proxyHint: {
        margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
    },
    proxyCheck: {
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
    },
    proxyMessage: { margin: 0, fontSize: 12, lineHeight: '18px' },
    proxyActions: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 },
    modalOverlay: {
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        background: 'rgba(0, 0, 0, 0.45)',
    },
    modal: {
        width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
        boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12,
        padding: '16px 18px', borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
    },
    modalHeader: { display: 'flex', alignItems: 'center', gap: 8 },
    modalTitle: { fontWeight: 600, fontSize: 15, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
};
/** Status dot color for one provider state. */
function dotColor(status) {
    if (status?.busy === true)
        return 'var(--dsw-alias-state-warn-label)';
    if (status?.loggedIn === true)
        return 'var(--dsw-alias-state-success-primary)';
    return 'var(--dsw-alias-label-dimmed)';
}
/**
 * One-line status text for one provider state.
 * @param t - section translate.
 * @param status - the provider's last reported state.
 * @returns the localized status line.
 */
function statusText(t, status) {
    if (status === undefined)
        return t('checking');
    if (status.busy)
        return t('loginInProgress');
    if (status.loggedIn) {
        const params = {};
        if (status.account !== undefined)
            params.account = status.account;
        if (status.expiresAt !== undefined)
            params.date = new Date(status.expiresAt).toLocaleString();
        if (params.account !== undefined && params.date !== undefined)
            return t('loggedInAccountExpires', params);
        if (params.account !== undefined)
            return t('loggedInAccount', params);
        if (params.date !== undefined)
            return t('loggedInExpires', params);
        return t('loggedIn');
    }
    return t('notLoggedIn');
}
/**
 * Localized label of one usage window (kind, plus the model scope when named).
 * @param t - section translate.
 * @param window - the reported window.
 * @returns e.g. "5-hour window" or "Weekly · Opus".
 */
function usageWindowLabel(t, window) {
    const base = window.kind === 'session'
        ? t('usageSession')
        : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow');
    return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base;
}
/** Bar fill color: success normally, warn from 80%, error from 95%. */
function usageBarColor(usedPercent) {
    if (usedPercent >= 95)
        return 'var(--dsw-alias-state-error-primary)';
    if (usedPercent >= 80)
        return 'var(--dsw-alias-state-warn-label)';
    return 'var(--dsw-alias-state-success-primary)';
}
/** One-line status text of the proxy config card. */
function proxyStatusText(t, proxy, loadError) {
    if (loadError !== undefined)
        return t('proxyLoadFailed', { message: loadError });
    if (proxy === undefined)
        return t('proxyLoading');
    if (proxy.error !== undefined)
        return t('proxyStatusError', { message: proxy.error });
    if (proxy.enabled)
        return t('proxyStatusEnabled', { url: proxy.url });
    return t('proxyStatusNone');
}
/** Feedback-line color of the proxy dialog. */
function messageColor(tone) {
    return tone === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : 'var(--dsw-alias-state-success-primary)';
}
/**
 * Derive one provider's default-effort section from its catalog and filter.
 * Pure so the collapsed-header counts and the filter stay testable without a
 * DOM: rows come only from models that advertise levels, the count of the rest
 * rides as one line, and the filter matches display name or model id.
 * @param models - the provider's catalog models, or undefined while loading.
 * @param filter - the raw filter input (trimmed and lowercased here).
 * @returns the section's rows and header counts.
 */
export function deriveModelDefaultsView(models, filter) {
    const all = models ?? [];
    const withEfforts = all.filter(model => model.efforts.length > 0);
    const query = filter.trim().toLowerCase();
    const shown = query === ''
        ? withEfforts
        : withEfforts.filter(model => model.name.toLowerCase().includes(query)
            || model.id.toLowerCase().includes(query));
    return {
        shown,
        total: withEfforts.length,
        overridden: withEfforts.filter(model => model.configured !== undefined).length,
        withoutEfforts: all.length - withEfforts.length,
        showFilter: withEfforts.length > MODEL_FILTER_THRESHOLD,
    };
}
/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export function SubscriptionsSection(props) {
    const { rpc } = props;
    const t = props.t ?? fallbackTranslate;
    const [statuses, setStatuses] = useState({});
    const [errors, setErrors] = useState({});
    const [manualDrafts, setManualDrafts] = useState({
        codex: '', claude: '', grok: '', copilot: '',
    });
    /** Pending device-flow codes (copilot), shown while the attempt polls. */
    const [deviceCodes, setDeviceCodes] = useState({});
    const [copiedCode, setCopiedCode] = useState(undefined);
    const [usages, setUsages] = useState({});
    const [usageErrors, setUsageErrors] = useState({});
    const [usageLoading, setUsageLoading] = useState({});
    const mountedRef = useRef(true);
    const pollersRef = useRef(new Map());
    /** Providers with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
    const usageInflightRef = useRef(new Set());
    /** Proxy config as last answered by `proxyGet`/`proxySet`. */
    const [proxy, setProxy] = useState(undefined);
    const [proxyLoadError, setProxyLoadError] = useState(undefined);
    /** Proxy dialog state (draft fields; the password never pre-fills). */
    const [proxyOpen, setProxyOpen] = useState(false);
    const [proxyEnabled, setProxyEnabled] = useState(false);
    const [proxyUrl, setProxyUrl] = useState('');
    const [proxyUsername, setProxyUsername] = useState('');
    const [proxyPassword, setProxyPassword] = useState('');
    const [proxyClearPassword, setProxyClearPassword] = useState(false);
    const [proxyBypass, setProxyBypass] = useState('');
    const [proxySaving, setProxySaving] = useState(false);
    const [proxyTesting, setProxyTesting] = useState(false);
    const [proxyMessage, setProxyMessage] = useState(undefined);
    const [proxyTestResult, setProxyTestResult] = useState(undefined);
    /** Per-model default-effort picker state as answered by `modelDefaults`. */
    const [modelDefaults, setModelDefaults] = useState({});
    const [modelDefaultsLoading, setModelDefaultsLoading] = useState(false);
    const [modelDefaultsLoadError, setModelDefaultsLoadError] = useState(undefined);
    /** One set in flight: the `${provider}/${model}` key. */
    const [modelDefaultsSaving, setModelDefaultsSaving] = useState(undefined);
    /** Per-model save failures, keyed `${provider}/${model}`. */
    const [modelDefaultsSaveErrors, setModelDefaultsSaveErrors] = useState({});
    /** Providers whose default-effort disclosure is open (collapsed by default). */
    const [modelDefaultsOpen, setModelDefaultsOpen] = useState({});
    /** Per-provider name filter of the expanded list. */
    const [modelDefaultsFilters, setModelDefaultsFilters] = useState({});
    /** Guard the catalog effect against concurrent loads. */
    const modelDefaultsInflightRef = useRef(false);
    const setProviderError = useCallback((provider, message) => {
        if (!mountedRef.current)
            return;
        setErrors((prev) => {
            const next = { ...prev };
            if (message === undefined)
                delete next[provider];
            else
                next[provider] = message;
            return next;
        });
    }, []);
    const stopPolling = useCallback((provider) => {
        const poller = pollersRef.current.get(provider);
        if (poller !== undefined) {
            clearInterval(poller);
            pollersRef.current.delete(provider);
        }
    }, []);
    /** Refetch every provider's status; stop a provider's poller once its attempt settles. */
    const refresh = useCallback(async () => {
        if (rpc === undefined)
            return;
        let response;
        try {
            response = await callSubscriptionsAuth(rpc, 'status', {});
        }
        catch {
            // A failed poll must not kill the page; busy providers keep polling and
            // the action paths report their own errors.
            return;
        }
        if (!mountedRef.current)
            return;
        setStatuses(response.providers);
        for (const { id } of PROVIDERS) {
            const status = response.providers[id];
            if (status.loggedIn || !status.busy) {
                stopPolling(id);
                // The attempt settled (success, timeout, or cancel): drop the code card.
                setDeviceCodes((prev) => {
                    if (prev[id] === undefined)
                        return prev;
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }
        }
    }, [rpc, stopPolling]);
    const startPolling = useCallback((provider) => {
        if (pollersRef.current.has(provider))
            return;
        pollersRef.current.set(provider, setInterval(() => { void refresh(); }, POLL_INTERVAL_MS));
    }, [refresh]);
    // Initial load; every busy provider (e.g. an attempt started before a page
    // reload) resumes polling. Teardown clears pollers and the mounted guard.
    useEffect(() => {
        mountedRef.current = true;
        void refresh().then(() => {
            if (!mountedRef.current)
                return;
            setStatuses((current) => {
                for (const { id } of PROVIDERS) {
                    if (current[id]?.busy === true)
                        startPolling(id);
                }
                return current;
            });
        });
        return () => {
            mountedRef.current = false;
            for (const poller of pollersRef.current.values())
                clearInterval(poller);
            pollersRef.current.clear();
        };
    }, [refresh, startPolling]);
    const loadUsage = useCallback(async (provider) => {
        if (rpc === undefined || usageInflightRef.current.has(provider))
            return;
        usageInflightRef.current.add(provider);
        setUsageLoading(prev => ({ ...prev, [provider]: true }));
        try {
            const usage = await callSubscriptionsAuth(rpc, 'usage', { provider });
            if (!mountedRef.current)
                return;
            setUsages(prev => ({ ...prev, [provider]: usage }));
            setUsageErrors((prev) => {
                const next = { ...prev };
                delete next[provider];
                return next;
            });
        }
        catch (error) {
            if (mountedRef.current)
                setUsageErrors(prev => ({ ...prev, [provider]: messageOf(error) }));
        }
        finally {
            usageInflightRef.current.delete(provider);
            if (mountedRef.current)
                setUsageLoading(prev => ({ ...prev, [provider]: false }));
        }
    }, [rpc]);
    // Fetch usage once a provider is logged in; drop the cached snapshot on
    // logout so a re-login refetches. A failed lookup does not auto-retry — the
    // per-card Refresh button is the retry path.
    useEffect(() => {
        for (const { id } of PROVIDERS) {
            const status = statuses[id];
            if (status === undefined)
                continue;
            if (status.loggedIn) {
                if (usages[id] === undefined && usageErrors[id] === undefined)
                    void loadUsage(id);
            }
            else if (usages[id] !== undefined || usageErrors[id] !== undefined) {
                setUsages((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
                setUsageErrors((prev) => {
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }
        }
    }, [statuses, usages, usageErrors, loadUsage]);
    const loadModelDefaultsData = useCallback(async () => {
        if (rpc === undefined || modelDefaultsInflightRef.current)
            return;
        modelDefaultsInflightRef.current = true;
        setModelDefaultsLoading(true);
        try {
            const catalog = await callSubscriptionsAuth(rpc, 'modelDefaults', {});
            if (!mountedRef.current)
                return;
            const next = {};
            for (const entry of catalog)
                next[entry.provider] = entry;
            setModelDefaults(next);
            setModelDefaultsLoadError(undefined);
        }
        catch (error) {
            if (mountedRef.current)
                setModelDefaultsLoadError(messageOf(error));
        }
        finally {
            modelDefaultsInflightRef.current = false;
            if (mountedRef.current)
                setModelDefaultsLoading(false);
        }
    }, [rpc]);
    // Fetch the default-effort catalogs only once a card's list is expanded: the
    // node half resolves live model info per model, so a collapsed page must not
    // pay for it. Drop the snapshot when the last provider logs out so a
    // re-login refetches. One fetch covers every logged-in provider (the node
    // half answers them together).
    useEffect(() => {
        const anyLoggedIn = PROVIDERS.some(({ id }) => statuses[id]?.loggedIn === true);
        if (anyLoggedIn) {
            const anyOpen = PROVIDERS.some(({ id }) => modelDefaultsOpen[id] === true && statuses[id]?.loggedIn === true);
            if (anyOpen && Object.keys(modelDefaults).length === 0 && modelDefaultsLoadError === undefined) {
                void loadModelDefaultsData();
            }
        }
        else if (Object.keys(modelDefaults).length > 0 || Object.keys(modelDefaultsOpen).length > 0) {
            setModelDefaults({});
            setModelDefaultsSaveErrors({});
            setModelDefaultsLoadError(undefined);
            setModelDefaultsOpen({});
            setModelDefaultsFilters({});
        }
    }, [statuses, modelDefaults, modelDefaultsOpen, modelDefaultsLoadError, loadModelDefaultsData]);
    /** Open or close one provider's default-effort disclosure. */
    const toggleModelDefaults = useCallback((provider) => {
        setModelDefaultsOpen(prev => ({ ...prev, [provider]: prev[provider] !== true }));
    }, []);
    const setModelDefault = useCallback(async (provider, model, effort) => {
        if (rpc === undefined)
            return;
        const key = `${provider}/${model}`;
        setModelDefaultsSaving(key);
        setModelDefaultsSaveErrors((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
        });
        try {
            await callSubscriptionsAuth(rpc, 'setModelDefault', {
                provider,
                model,
                ...(effort === undefined ? {} : { effort }),
            });
            if (!mountedRef.current)
                return;
            setModelDefaults((prev) => {
                const section = prev[provider];
                if (section === undefined)
                    return prev;
                return {
                    ...prev,
                    [provider]: {
                        ...section,
                        models: section.models.map((entry) => {
                            if (entry.id !== model)
                                return entry;
                            if (effort !== undefined)
                                return { ...entry, configured: effort };
                            // Cleared: drop the key rather than keep the stale level, or the
                            // select would snap back and the header would keep counting it.
                            const { configured: _cleared, ...rest } = entry;
                            return rest;
                        }),
                    },
                };
            });
        }
        catch (error) {
            if (mountedRef.current)
                setModelDefaultsSaveErrors((prev) => ({ ...prev, [key]: messageOf(error) }));
        }
        finally {
            if (mountedRef.current)
                setModelDefaultsSaving(current => current === key ? undefined : current);
        }
    }, [rpc]);
    const login = useCallback(async (provider) => {
        if (rpc === undefined)
            return;
        setProviderError(provider, undefined);
        try {
            const response = await callSubscriptionsAuth(rpc, 'login', { provider });
            if (typeof response.authorizeUrl === 'string' && response.authorizeUrl === '') {
                // Instant login (e.g. imported from Claude Code credentials)
                await refresh();
                return;
            }
            if (typeof response.authorizeUrl !== 'string') {
                throw new SubscriptionsAuthError(t('loginMissingUrl'));
            }
            if (!mountedRef.current)
                return;
            // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
            setStatuses(prev => ({ ...prev, [provider]: { ...prev[provider], busy: true, loggedIn: false } }));
            if (typeof response.userCode === 'string' && response.userCode.length > 0) {
                // Device flow: show the code card instead of opening the page blind —
                // the user copies the code first, then opens the verification page.
                setDeviceCodes(prev => ({ ...prev, [provider]: { userCode: response.userCode, verificationUrl: response.authorizeUrl } }));
            }
            else {
                window.open(response.authorizeUrl, '_blank', 'noopener');
            }
            startPolling(provider);
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
    }, [rpc, t, setProviderError, startPolling]);
    const cancel = useCallback(async (provider) => {
        if (rpc === undefined)
            return;
        stopPolling(provider);
        try {
            await callSubscriptionsAuth(rpc, 'cancel', { provider });
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
        await refresh();
    }, [rpc, stopPolling, setProviderError, refresh]);
    const submitManual = useCallback(async (provider) => {
        if (rpc === undefined)
            return;
        const input = manualDrafts[provider].trim();
        if (input === '')
            return;
        setProviderError(provider, undefined);
        try {
            await callSubscriptionsAuth(rpc, 'manual', { provider, input });
            if (mountedRef.current)
                setManualDrafts(prev => ({ ...prev, [provider]: '' }));
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
        await refresh();
    }, [rpc, manualDrafts, setProviderError, refresh]);
    const logout = useCallback(async (provider, name) => {
        if (rpc === undefined)
            return;
        if (!window.confirm(t('logoutConfirm', { provider: name })))
            return;
        setProviderError(provider, undefined);
        try {
            await callSubscriptionsAuth(rpc, 'logout', { provider });
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
        await refresh();
    }, [rpc, t, setProviderError, refresh]);
    const copyDeviceCode = useCallback((provider, userCode) => {
        void navigator.clipboard?.writeText(userCode).then(() => {
            if (!mountedRef.current)
                return;
            setCopiedCode(provider);
            setTimeout(() => {
                if (mountedRef.current) {
                    setCopiedCode(current => current === provider ? undefined : current);
                }
            }, 1500);
        }).catch(() => undefined);
    }, []);
    // Proxy configuration: load once on mount; the dialog drives proxySet/proxyTest.
    useEffect(() => {
        if (rpc === undefined)
            return;
        let alive = true;
        void callSubscriptionsAuth(rpc, 'proxyGet', {}).then((view) => {
            if (!alive)
                return;
            setProxy(view);
            setProxyLoadError(undefined);
        }).catch((error) => {
            if (alive)
                setProxyLoadError(messageOf(error));
        });
        return () => { alive = false; };
    }, [rpc]);
    useEffect(() => {
        if (!proxyOpen)
            return;
        const onKey = (event) => {
            if (event.key === 'Escape')
                setProxyOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [proxyOpen]);
    const openProxyDialog = useCallback(() => {
        if (proxy === undefined)
            return;
        setProxyEnabled(proxy.enabled);
        setProxyUrl(proxy.url);
        setProxyUsername(proxy.username ?? '');
        setProxyPassword('');
        setProxyClearPassword(false);
        setProxyBypass(proxy.bypass.join(', '));
        setProxyMessage(undefined);
        setProxyTestResult(undefined);
        setProxyOpen(true);
    }, [proxy]);
    const saveProxy = useCallback(async () => {
        if (rpc === undefined)
            return;
        setProxySaving(true);
        setProxyMessage(undefined);
        try {
            const view = await callSubscriptionsAuth(rpc, 'proxySet', {
                enabled: proxyEnabled,
                url: proxyUrl.trim(),
                username: proxyUsername,
                ...proxyClearPassword ? { password: null } : proxyPassword !== '' ? { password: proxyPassword } : {},
                bypass: proxyBypass.split(/[,\n]/).map(entry => entry.trim()).filter(entry => entry !== ''),
            });
            setProxy(view);
            setProxyLoadError(undefined);
            setProxyMessage({ tone: 'success', text: t('proxySaved') });
            setProxyOpen(false);
        }
        catch (error) {
            setProxyMessage({ tone: 'error', text: t('proxySaveFailed', { message: messageOf(error) }) });
        }
        finally {
            setProxySaving(false);
        }
    }, [rpc, proxyEnabled, proxyUrl, proxyUsername, proxyPassword, proxyClearPassword, proxyBypass, t]);
    const testProxy = useCallback(async () => {
        if (rpc === undefined || proxyTesting)
            return;
        setProxyTesting(true);
        setProxyTestResult(undefined);
        try {
            // Test the dialog's current inputs (they do not need to be saved first);
            // the host builds a throwaway agent for the probe.
            setProxyTestResult(await callSubscriptionsAuth(rpc, 'proxyTest', {
                proxy: {
                    url: proxyUrl.trim(),
                    ...proxyUsername.trim() !== '' ? { username: proxyUsername.trim() } : {},
                    ...proxyPassword !== '' ? { password: proxyPassword } : {},
                },
            }));
        }
        catch (error) {
            setProxyTestResult({ ok: false, viaProxy: false, error: messageOf(error) });
        }
        finally {
            setProxyTesting(false);
        }
    }, [rpc, proxyTesting, proxyUrl, proxyUsername, proxyPassword]);
    if (rpc === undefined) {
        return _jsx("p", { style: styles.intro, children: t('unavailable') });
    }
    return (_jsxs("div", { style: styles.section, children: [_jsx("p", { style: styles.intro, children: t('intro') }), _jsxs("div", { style: styles.proxyCard, children: [_jsxs("div", { style: styles.cardHeader, children: [_jsx("span", { style: {
                                    ...styles.dot,
                                    background: proxy?.enabled === true
                                        ? 'var(--dsw-alias-state-success-primary)'
                                        : 'var(--dsw-alias-label-dimmed)',
                                } }), _jsx("span", { style: styles.name, children: t('proxyTitle') }), _jsx("button", { type: "button", style: { ...styles.button, marginLeft: 'auto', flexShrink: 0 }, onClick: openProxyDialog, children: t('proxyConfigure') })] }), _jsx("p", { style: styles.statusLine, children: proxyStatusText(t, proxy, proxyLoadError) })] }), _jsx("div", { style: styles.separator }), PROVIDERS.map(({ id, name }) => {
                const status = statuses[id];
                const busy = status?.busy === true;
                const deviceCode = deviceCodes[id];
                const usage = usages[id];
                const usageError = usageErrors[id];
                // Providers without a usage endpoint answer supported:false — no block.
                const showUsage = status?.loggedIn === true && usage?.supported !== false
                    && (usage !== undefined || usageError !== undefined || usageLoading[id] === true);
                return (_jsxs("div", { style: styles.card, children: [_jsxs("div", { style: styles.cardHeader, children: [_jsx("span", { style: { ...styles.dot, background: dotColor(status) } }), _jsx("span", { style: styles.name, children: name })] }), _jsx("p", { style: styles.statusLine, children: statusText(t, status) }), status?.detail !== undefined && status.detail !== '' && (_jsx("p", { style: styles.statusLine, children: status.detail })), errors[id] !== undefined && _jsx("p", { style: styles.errorLine, children: errors[id] }), _jsxs("div", { style: styles.actions, children: [!busy && status?.loggedIn !== true && (_jsx("button", { type: "button", style: styles.button, onClick: () => { void login(id); }, children: t('login') })), busy && (_jsx("button", { type: "button", style: styles.button, onClick: () => { void cancel(id); }, children: t('cancel') })), status?.loggedIn === true && (_jsx("button", { type: "button", style: styles.button, onClick: () => { void logout(id, name); }, children: t('logout') }))] }), showUsage && (_jsxs("div", { style: styles.usage, children: [_jsxs("div", { style: styles.usageHeader, children: [_jsx("span", { style: styles.usageTitle, children: t('usageTitle') }), usage?.plan !== undefined && (_jsx("span", { style: styles.usagePlan, children: t('usagePlan', { plan: usage.plan }) })), _jsx("button", { type: "button", style: { ...styles.usageRefresh, ...usageLoading[id] === true ? { opacity: 0.5, cursor: 'default' } : {} }, disabled: usageLoading[id] === true, onClick: () => { void loadUsage(id); }, children: t('usageRefresh') })] }), usage === undefined && usageError === undefined && (_jsx("p", { style: styles.statusLine, children: t('usageLoading') })), usageError !== undefined && (_jsx("p", { style: styles.errorLine, children: t('usageError', { message: usageError }) })), usage?.windows !== undefined && usage.windows.length === 0 && (_jsx("p", { style: styles.statusLine, children: t('usageEmpty') })), (usage?.windows ?? []).map((window, index) => {
                                    const percent = Math.min(100, Math.max(0, window.usedPercent));
                                    return (_jsxs("div", { style: styles.usageRow, children: [_jsxs("div", { style: styles.usageMeta, children: [_jsx("span", { children: usageWindowLabel(t, window) }), _jsxs("span", { children: [`${String(Math.round(percent))}%`, window.resetsAt !== undefined
                                                                && ` · ${t('usageResets', { date: new Date(window.resetsAt).toLocaleString() })}`] })] }), _jsx("div", { style: styles.usageTrack, children: _jsx("div", { style: { ...styles.usageFill, width: `${String(percent)}%`, background: usageBarColor(percent) } }) })] }, index));
                                })] })), status?.loggedIn === true && (() => {
                            // Collapsed by default: providers with a large catalog (Copilot
                            // lists dozens of models) must not push the page down. The
                            // header carries the summary so the collapsed state still says
                            // how many models are overridden.
                            const open = modelDefaultsOpen[id] === true;
                            const catalog = modelDefaults[id];
                            const filter = modelDefaultsFilters[id] ?? '';
                            const view = deriveModelDefaultsView(catalog?.models, filter);
                            const saveErrors = Object.entries(modelDefaultsSaveErrors).filter(([key]) => key.startsWith(`${id}/`));
                            return (_jsxs("div", { style: styles.defaultEffort, children: [_jsxs("button", { type: "button", style: styles.defaultEffortToggle, "aria-expanded": open, onClick: () => { toggleModelDefaults(id); }, children: [_jsx("span", { style: styles.usageTitle, children: t('modelDefaultsTitle') }), _jsx("span", { style: styles.usagePlan, children: catalog === undefined
                                                    ? (modelDefaultsLoading ? t('modelDefaultsLoading') : '')
                                                    : view.total === 0
                                                        ? t('modelDefaultsSummaryEmpty')
                                                        : view.overridden === 0
                                                            ? t('modelDefaultsSummaryNone', { total: view.total })
                                                            : t('modelDefaultsSummary', { total: view.total, configured: view.overridden }) }), _jsx("span", { style: styles.defaultEffortChevron, "aria-label": open ? t('modelDefaultsCollapse') : t('modelDefaultsExpand'), children: open ? '▲' : '▼' })] }), saveErrors.map(([key, message]) => (_jsx("p", { style: styles.errorLine, children: t('modelDefaultsSaveFailed', { message }) }, key))), open && (_jsxs(_Fragment, { children: [_jsx("p", { style: styles.statusLine, children: t('modelDefaultsHint') }), modelDefaultsLoadError !== undefined && (_jsxs(_Fragment, { children: [_jsx("p", { style: styles.errorLine, children: t('modelDefaultsLoadFailed', { message: modelDefaultsLoadError }) }), _jsx("div", { style: styles.actions, children: _jsx("button", { type: "button", style: styles.button, onClick: () => {
                                                                setModelDefaultsLoadError(undefined);
                                                                void loadModelDefaultsData();
                                                            }, children: t('modelDefaultsRetry') }) })] })), modelDefaultsLoadError === undefined && catalog === undefined && (_jsx("p", { style: styles.statusLine, children: t('modelDefaultsLoading') })), view.showFilter && (_jsx("input", { style: styles.defaultEffortFilter, value: filter, placeholder: t('modelDefaultsFilterPlaceholder'), onChange: (event) => {
                                                    setModelDefaultsFilters(prev => ({ ...prev, [id]: event.target.value }));
                                                } })), view.shown.length > 0 && (_jsx("div", { style: styles.defaultEffortList, children: view.shown.map(model => (_jsxs("div", { style: styles.defaultEffortRow, children: [_jsx("span", { style: styles.defaultEffortName, title: model.id, children: model.name }), _jsxs("select", { style: styles.defaultEffortSelect, value: model.configured ?? '', disabled: modelDefaultsSaving === `${id}/${model.id}`, onChange: (event) => {
                                                                void setModelDefault(id, model.id, event.target.value === '' ? undefined : event.target.value);
                                                            }, children: [_jsx("option", { value: "", children: t('modelDefaultsFollowProvider') }), model.efforts.map(effort => (_jsx("option", { value: effort.id, children: effort.name }, effort.id)))] })] }, model.id))) })), catalog !== undefined && view.shown.length === 0 && filter.trim() !== '' && (_jsx("p", { style: styles.statusLine, children: t('modelDefaultsFilterEmpty', { query: filter.trim() }) })), view.withoutEfforts > 0 && (_jsx("p", { style: styles.statusLine, children: t('modelDefaultsNoLevels', { count: view.withoutEfforts }) }))] }))] }));
                        })(), busy && deviceCode !== undefined && (_jsxs("div", { style: styles.deviceCode, children: [_jsx("span", { style: styles.statusLine, children: t('deviceCodePrompt') }), _jsx("span", { style: styles.deviceCodeText, children: deviceCode.userCode }), _jsxs("div", { style: styles.actions, children: [_jsx("button", { type: "button", style: styles.button, onClick: () => { copyDeviceCode(id, deviceCode.userCode); }, children: copiedCode === id ? t('deviceCodeCopied') : t('deviceCodeCopy') }), _jsx("button", { type: "button", style: styles.button, onClick: () => { window.open(deviceCode.verificationUrl, '_blank', 'noopener'); }, children: t('deviceCodeOpenPage') })] })] })), busy && deviceCode === undefined && (_jsxs("details", { style: styles.manual, children: [_jsx("summary", { children: t('manualSummary') }), _jsxs("div", { style: styles.manualRow, children: [_jsx("input", { style: styles.manualInput, value: manualDrafts[id], placeholder: t('manualPlaceholder'), onChange: event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value })) }), _jsx("button", { type: "button", style: styles.button, onClick: () => { void submitManual(id); }, children: t('submit') })] })] }))] }, id));
            }), proxyOpen && (_jsx("div", { style: styles.modalOverlay, onClick: () => setProxyOpen(false), children: _jsxs("div", { style: styles.modal, onClick: event => event.stopPropagation(), children: [_jsxs("div", { style: styles.modalHeader, children: [_jsx("span", { style: styles.modalTitle, children: t('proxyDialogTitle') }), _jsx("button", { type: "button", style: { ...styles.button, marginLeft: 'auto' }, onClick: () => setProxyOpen(false), children: t('proxyDialogClose') })] }), _jsxs("label", { style: styles.proxyCheck, children: [_jsx("input", { type: "checkbox", checked: proxyEnabled, onChange: event => setProxyEnabled(event.target.checked) }), _jsx("span", { children: t('proxyEnabled') })] }), _jsxs("label", { style: styles.proxyField, children: [_jsx("span", { style: styles.proxyLabel, children: t('proxyUrl') }), _jsx("input", { style: styles.proxyInput, value: proxyUrl, placeholder: t('proxyUrlPlaceholder'), onChange: event => setProxyUrl(event.target.value) }), _jsx("p", { style: styles.proxyHint, children: t('proxyUrlHint') })] }), _jsxs("label", { style: styles.proxyField, children: [_jsx("span", { style: styles.proxyLabel, children: t('proxyUsername') }), _jsx("input", { style: styles.proxyInput, value: proxyUsername, placeholder: t('proxyUsernamePlaceholder'), onChange: event => setProxyUsername(event.target.value) })] }), _jsxs("div", { style: styles.proxyField, children: [_jsx("span", { style: styles.proxyLabel, children: t('proxyPassword') }), _jsx("input", { type: "password", style: styles.proxyInput, value: proxyPassword, placeholder: t('proxyPasswordPlaceholder'), onChange: event => setProxyPassword(event.target.value) }), _jsxs("label", { style: styles.proxyCheck, children: [_jsx("input", { type: "checkbox", checked: proxyClearPassword, onChange: event => setProxyClearPassword(event.target.checked) }), _jsx("span", { children: t('proxyClearPassword') })] })] }), _jsxs("label", { style: styles.proxyField, children: [_jsx("span", { style: styles.proxyLabel, children: t('proxyBypass') }), _jsx("input", { style: styles.proxyInput, value: proxyBypass, placeholder: t('proxyBypassPlaceholder'), onChange: event => setProxyBypass(event.target.value) }), _jsx("p", { style: styles.proxyHint, children: t('proxyBypassHint') })] }), _jsx("p", { style: styles.proxyHint, children: t('proxyNote') }), proxyMessage !== undefined && (_jsx("p", { style: { ...styles.proxyMessage, color: messageColor(proxyMessage.tone) }, children: proxyMessage.text })), proxyTestResult !== undefined && (_jsx("p", { style: {
                                ...styles.proxyMessage,
                                color: proxyTestResult.ok
                                    ? 'var(--dsw-alias-state-success-primary)'
                                    : 'var(--dsw-alias-state-error-primary)',
                            }, children: proxyTestResult.ok
                                ? (proxyTestResult.viaProxy
                                    ? t('proxyTestOk', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) })
                                    : t('proxyTestOkDirect', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) }))
                                : t('proxyTestFail', { message: proxyTestResult.error ?? '' }) })), _jsxs("div", { style: styles.proxyActions, children: [_jsx("button", { type: "button", style: { ...styles.button, ...proxyTesting ? { opacity: 0.5, cursor: 'default' } : {} }, disabled: proxyTesting, onClick: () => { void testProxy(); }, children: proxyTesting ? t('proxyTesting') : t('proxyTest') }), _jsx("button", { type: "button", style: { ...styles.button, ...proxySaving ? { opacity: 0.5, cursor: 'default' } : {} }, disabled: proxySaving, onClick: () => { void saveProxy(); }, children: proxySaving ? t('proxySaving') : t('proxySave') }), _jsx("button", { type: "button", style: styles.button, onClick: () => setProxyOpen(false), children: t('proxyCancel') })] })] }) }))] }));
}
