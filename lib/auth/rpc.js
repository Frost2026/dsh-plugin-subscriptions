/**
 * The `/subscriptions-auth` host RPC channel the web Settings page drives. The
 * channel is registered only when a host `connection` service exists (the web
 * profile); headless compositions load the plugin without it. All business
 * outcomes are returned as RpcResult values; handlers never throw.
 */
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { PROVIDER_IDS } from './store.js';
/** The RPC channel this plugin registers on the host connection. */
export const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth';
/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/;
/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
class BadRequest extends Error {
}
function ok(value) {
    return { ok: true, value };
}
function failure(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BadRequest) {
        // The issues array is zod-shaped upstream; this channel validates by hand.
        return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } };
    }
    return { ok: false, error: { code: 'internal', message, details: {} } };
}
function readProvider(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    const provider = payload.provider;
    if (typeof provider !== 'string' || !PROVIDER_IDS.includes(provider)) {
        throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(', ')}`);
    }
    return provider;
}
function readString(payload, field) {
    const value = payload[field];
    if (typeof value !== 'string' || value.length === 0) {
        throw new BadRequest(`payload.${field} must be a non-empty string`);
    }
    return value;
}
/** Validate the `setModelDefault` endpoint's payload. */
function readModelDefaultInput(payload) {
    const provider = readProvider(payload);
    const model = readString(payload, 'model');
    const record = payload;
    let effort;
    if (record.effort !== undefined) {
        if (typeof record.effort !== 'string' || record.effort.length === 0) {
            throw new BadRequest('payload.effort must be a non-empty string when present');
        }
        effort = record.effort;
    }
    return {
        provider,
        model,
        ...(effort === undefined ? {} : { effort }),
    };
}
/** Validate the `setSpeed` endpoint's tier. */
function readSpeedTier(payload) {
    const tier = payload.tier;
    if (tier !== 'standard' && tier !== 'fast') {
        throw new BadRequest('payload.tier must be "standard" or "fast"');
    }
    return tier;
}
/** Validate the `image` endpoint's payload into a full attachment reference. */
function readImageRef(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    const record = payload;
    const attachmentId = record.attachmentId;
    if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
        throw new BadRequest('payload.attachmentId must be a non-empty string');
    }
    const mediaType = record.mediaType;
    if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.includes(mediaType)) {
        throw new BadRequest(`payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`);
    }
    for (const field of ['bytes', 'width', 'height']) {
        const value = record[field];
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
            throw new BadRequest(`payload.${field} must be a positive integer`);
        }
    }
    const name = record.name;
    if (name !== undefined && typeof name !== 'string') {
        throw new BadRequest('payload.name must be a string when present');
    }
    return {
        attachmentId: AttachmentId(attachmentId),
        mediaType: mediaType,
        bytes: record.bytes,
        width: record.width,
        height: record.height,
        ...name === undefined ? {} : { name: name },
    };
}
/**
 * Validate the `video` endpoint's payload into a bare file name. Rejecting
 * anything with a path separator (the pattern allows none) pins every read
 * inside the plugin's videos directory.
 */
function readVideoName(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    const name = payload.name;
    if (typeof name !== 'string' || !VIDEO_NAME_PATTERN.test(name)) {
        throw new BadRequest('payload.name must be a bare .mp4 file name');
    }
    return name;
}
/** Validate the session id both speed endpoints carry. */
function readSessionId(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    return readString(payload, 'sessionId');
}
/** Validate a `proxySet` payload into a shape `ProxyInput` accepts. */
function readProxyInput(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    const record = payload;
    if (typeof record.enabled !== 'boolean')
        throw new BadRequest('payload.enabled must be a boolean');
    if (typeof record.url !== 'string')
        throw new BadRequest('payload.url must be a string');
    let username;
    if (record.username !== undefined) {
        if (typeof record.username !== 'string')
            throw new BadRequest('payload.username must be a string when present');
        username = record.username;
    }
    let password;
    if (record.password !== undefined) {
        if (record.password !== null && typeof record.password !== 'string') {
            throw new BadRequest('payload.password must be a string or null when present');
        }
        password = record.password;
    }
    let bypass;
    if (record.bypass !== undefined) {
        if (!Array.isArray(record.bypass) || record.bypass.some(entry => typeof entry !== 'string')) {
            throw new BadRequest('payload.bypass must be an array of strings when present');
        }
        bypass = record.bypass;
    }
    return {
        enabled: record.enabled,
        url: record.url,
        ...username === undefined ? {} : { username },
        ...password === undefined ? {} : { password },
        ...bypass === undefined ? {} : { bypass },
    };
}
/** Validate a `proxyTest` payload (the destination URL and an optional draft). */
function readProxyTestPayload(payload) {
    if (typeof payload !== 'object' || payload === null)
        return {};
    const record = payload;
    const url = record.url;
    if (url === undefined && record.proxy === undefined)
        return {};
    if (url !== undefined && (typeof url !== 'string' || url.length === 0)) {
        throw new BadRequest('payload.url must be a non-empty string when present');
    }
    let proxy;
    if (record.proxy !== undefined) {
        if (typeof record.proxy !== 'object' || record.proxy === null) {
            throw new BadRequest('payload.proxy must be an object when present');
        }
        const draftRecord = record.proxy;
        if (typeof draftRecord.url !== 'string' || draftRecord.url.length === 0) {
            throw new BadRequest('payload.proxy.url must be a non-empty string');
        }
        let username;
        if (draftRecord.username !== undefined) {
            if (typeof draftRecord.username !== 'string') {
                throw new BadRequest('payload.proxy.username must be a string when present');
            }
            username = draftRecord.username;
        }
        let password;
        if (draftRecord.password !== undefined) {
            if (typeof draftRecord.password !== 'string') {
                throw new BadRequest('payload.proxy.password must be a string when present');
            }
            password = draftRecord.password;
        }
        proxy = {
            url: draftRecord.url,
            ...username === undefined ? {} : { username },
            ...password === undefined ? {} : { password },
        };
    }
    return {
        ...url === undefined ? {} : { url },
        ...proxy === undefined ? {} : { proxy },
    };
}
async function dispatch(controller, speed, proxy, modelDefaults, endpoint, payload, signal) {
    switch (endpoint) {
        case 'status': {
            const entries = await Promise.all(PROVIDER_IDS.map(async (provider) => [provider, await controller.status(provider)]));
            return ok({ providers: Object.fromEntries(entries) });
        }
        case 'login':
            return ok(await controller.login(readProvider(payload)));
        case 'manual': {
            const provider = readProvider(payload);
            await controller.manual(provider, readString(payload, 'input'));
            return ok({ ok: true });
        }
        case 'cancel':
            await controller.cancel(readProvider(payload));
            return ok({ ok: true });
        case 'logout':
            await controller.logout(readProvider(payload));
            return ok({ ok: true });
        case 'usage':
            return ok(await controller.usage(readProvider(payload), signal));
        case 'image':
            return ok(await controller.readImage(readImageRef(payload), signal));
        case 'video':
            return ok(await controller.readVideo(readVideoName(payload), signal));
        case 'speed':
            return ok(await speed.speed(readSessionId(payload)));
        case 'setSpeed':
            await speed.setSpeed(readSessionId(payload), readSpeedTier(payload));
            return ok({ ok: true });
        case 'proxyGet':
            if (proxy === undefined)
                throw new BadRequest('proxy configuration is unavailable');
            return ok(await proxy.get());
        case 'proxySet':
            if (proxy === undefined)
                throw new BadRequest('proxy configuration is unavailable');
            return ok(await proxy.set(readProxyInput(payload)));
        case 'proxyTest':
            if (proxy === undefined)
                throw new BadRequest('proxy configuration is unavailable');
            return ok(await proxy.test(readProxyTestPayload(payload)));
        case 'modelDefaults':
            if (modelDefaults === undefined)
                throw new BadRequest('model defaults are unavailable');
            return ok(await modelDefaults.catalog());
        case 'setModelDefault':
            if (modelDefaults === undefined)
                throw new BadRequest('model defaults are unavailable');
            {
                const input = readModelDefaultInput(payload);
                await modelDefaults.set(input.provider, input.model, input.effort);
            }
            return ok({ ok: true });
        default:
            throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`);
    }
}
/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param controller - the auth operations backing the endpoints.
 * @param speed - the per-session speed-tier state backing the Speed toggle.
 * @param proxy - optional proxy-config controller backing `proxyGet`/`proxySet`/`proxyTest`.
 * @param modelDefaults - optional per-model default-effort state backing `modelDefaults`/`setModelDefault`.
 */
export function registerAuthRpc(ctx, controller, speed, proxy = undefined, modelDefaults = undefined) {
    // `connection` is not in this plugin's inject list (headless compositions
    // lack it), so its startup order is unconstrained: defer registration until
    // the service exists instead of probing once at apply time.
    ctx.inject(['connection'], (ctx) => {
        const connection = ctx.get('connection');
        ctx.effect(() => connection.rpc.handle(SUBSCRIPTIONS_AUTH_CHANNEL, async (endpoint, payload, signal) => {
            try {
                return await dispatch(controller, speed, proxy, modelDefaults, endpoint, payload, signal);
            }
            catch (error) {
                return failure(error);
            }
        }, { authority: 'loopback' }), 'dsh-plugin-subscriptions: /subscriptions-auth rpc channel');
    });
}
