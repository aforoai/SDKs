/**
 * Reads an Aforo key from AWS Secrets Manager, once per container (G337).
 *
 * Shared by index.js (AFORO_API_KEY_SECRET_ARN) and key-authorizer.js
 * (AFORO_TENANT_KEY_SECRET_ARN). The key then never sits in a Lambda
 * environment variable, where anyone with lambda:GetFunctionConfiguration can
 * read it in clear text.
 *
 * Built-ins only: the one-click deploy in organization-service zips these
 * files with no node_modules, so GetSecretValue is called over HTTPS and
 * signed with SigV4 here instead of through the AWS SDK. Credentials are the
 * function's execution-role credentials Lambda puts in AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.
 *
 * The secret value is the key as plain text, or JSON with an "apiKey" field.
 *
 * Env read by getSecretValue:
 *   AWS_REGION                         used when the secret id is a name, not an ARN
 *   AWS_ENDPOINT_URL_SECRETS_MANAGER   optional endpoint override (VPC endpoint,
 *                                      local testing); the same variable the AWS
 *                                      SDKs read
 */
'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DEFAULT_REFRESH_MS = 300000; // 5 min, the AWS Parameters and Secrets extension default
const FAILED_REFRESH_RETRY_MS = 30000;
// Before the first success: after a failed fetch, later calls fail fast for
// 5 s, doubling per consecutive failure up to 60 s, jittered to 50-100 % of
// the delay so cold containers do not retry in step.
const COLD_BACKOFF_BASE_MS = 5000;
const COLD_BACKOFF_MAX_MS = 60000;
const REQUEST_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 65536;

function sha256Hex(data) {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * SigV4 for one request. headers must not include host or x-amz-date; both are
 * added and signed. Returns { authorization, headers } where headers is every
 * header to send (lower-case names).
 */
function signV4({ method, host, path = '/', query = '', headers = {}, body = '', region, service, credentials, amzDate }) {
    const date = amzDate.slice(0, 8);
    const all = { ...lowerCaseKeys(headers), host, 'x-amz-date': amzDate };
    if (credentials.sessionToken) all['x-amz-security-token'] = credentials.sessionToken;

    const names = Object.keys(all).sort();
    const canonicalHeaders = names.map((n) => `${n}:${String(all[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, sha256Hex(body)].join('\n');

    const scope = `${date}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${credentials.secretAccessKey}`, date);
    const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { authorization, headers: { ...all, authorization } };
}

function lowerCaseKeys(obj) {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
}

/** arn:<partition>:secretsmanager:<region>:<account>:secret:<name> → { partition, region }, or null. */
function parseSecretArn(secretId) {
    const parts = String(secretId).split(':');
    if (parts.length < 7 || parts[0] !== 'arn' || parts[2] !== 'secretsmanager') return null;
    return { partition: parts[1], region: parts[3] };
}

function secretsManagerUrl(secretId, env) {
    const override = (env.AWS_ENDPOINT_URL_SECRETS_MANAGER || '').trim();
    if (override) return override.endsWith('/') ? override : `${override}/`;
    const arn = parseSecretArn(secretId);
    const region = (arn && arn.region) || env.AWS_REGION || env.AWS_DEFAULT_REGION;
    if (!region) throw new Error('GetSecretValue: no region (use a secret ARN or set AWS_REGION)');
    const suffix = arn && arn.partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
    return `https://secretsmanager.${region}.${suffix}/`;
}

function amzDateNow() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** SecretString of secretId. Errors name the AWS error type only, never the value. */
function getSecretValue(secretId, env = process.env, timeoutMs = REQUEST_TIMEOUT_MS) {
    const credentials = {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
    };
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
        return Promise.reject(new Error('GetSecretValue: no AWS credentials in the environment'));
    }
    let url;
    try { url = new URL(secretsManagerUrl(secretId, env)); } catch (err) { return Promise.reject(err); }
    const arn = parseSecretArn(secretId);
    const region = (arn && arn.region) || env.AWS_REGION || env.AWS_DEFAULT_REGION;
    const body = JSON.stringify({ SecretId: secretId });
    const signed = signV4({
        method: 'POST',
        host: url.host,
        path: url.pathname || '/',
        headers: {
            'content-type': 'application/x-amz-json-1.1',
            'x-amz-target': 'secretsmanager.GetSecretValue',
        },
        body,
        region,
        service: 'secretsmanager',
        credentials,
        amzDate: amzDateNow(),
    });

    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'http:' ? http : https;
        const req = transport.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname || '/',
            method: 'POST',
            headers: { ...signed.headers, 'content-length': Buffer.byteLength(body) },
            timeout: timeoutMs,
        }, (res) => {
            let text = '';
            res.on('data', (c) => { if (text.length < MAX_RESPONSE_BYTES) text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { json = null; }
                if (res.statusCode !== 200) {
                    const type = json && typeof json.__type === 'string' ? json.__type.split('#').pop() : 'unknown error';
                    reject(new Error(`GetSecretValue failed: HTTP ${res.statusCode} ${type}`));
                    return;
                }
                if (!json || typeof json.SecretString !== 'string') {
                    reject(new Error('GetSecretValue: the secret has no SecretString (binary secrets are not supported)'));
                    return;
                }
                resolve(json.SecretString);
            });
        });
        req.on('timeout', () => req.destroy(new Error('GetSecretValue: timed out')));
        req.on('error', reject);
        req.end(body);
    });
}

/** The key from a secret value: plain text, or JSON {"apiKey": "..."}. */
function extractKey(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) throw new Error('the secret is empty');
    if (text.startsWith('{')) {
        let json;
        try { json = JSON.parse(text); } catch { throw new Error('the secret looks like JSON but does not parse'); }
        const key = json && typeof json.apiKey === 'string' ? json.apiKey.trim() : '';
        if (!key) throw new Error('the secret is JSON without an "apiKey" field');
        return key;
    }
    return text;
}

/**
 * A key read from Secrets Manager when secretIdEnv is set, else from the plain
 * plainEnv variable (deployments made before 2.4.0, and organization-service's
 * one-click deploy, which still sets the plain variable).
 *
 * The secret is fetched on first use and cached for the container. It is
 * refetched after refreshMs so a rotated key reaches warm containers; a failed
 * refresh keeps the last good value and retries 30 s later. A failed FIRST
 * fetch throws (the caller fails the invocation). Until a fetch succeeds,
 * later calls throw the same error without calling AWS for a backoff of 5 s,
 * doubling per failure up to 60 s, with jitter — so an outage or an IAM
 * mistake does not make every invocation wait on Secrets Manager.
 */
function createSecretSource({ label, secretIdEnv, plainEnv, env = process.env, fetchSecret,
    refreshMs = DEFAULT_REFRESH_MS, now = Date.now, random = Math.random }) {
    const secretId = String(env[secretIdEnv] || '').trim();
    const plain = String(env[plainEnv] || '');
    const fetch = fetchSecret || ((id) => getSecretValue(id, env));
    let value = null;
    let freshUntil = 0;
    let inflight = null;
    let warned = false;
    let coldFailures = 0;
    let coldRetryAt = 0;
    let coldError = null;

    if (secretId && plain) {
        console.warn(`${label}: ${secretIdEnv} is set, so ${plainEnv} is ignored. Remove ${plainEnv}.`);
    }

    async function get() {
        if (!secretId) {
            if (plain && !warned) {
                warned = true;
                console.warn(`${label} comes from the plain ${plainEnv} environment variable. ` +
                    `Store it in AWS Secrets Manager and set ${secretIdEnv} instead.`);
            }
            return plain;
        }
        if (value !== null && now() < freshUntil) return value;
        if (value === null && !inflight && coldError && now() < coldRetryAt) {
            throw coldError;
        }
        if (!inflight) {
            inflight = Promise.resolve()
                .then(() => fetch(secretId))
                .then((raw) => {
                    value = extractKey(raw);
                    freshUntil = now() + refreshMs;
                    coldFailures = 0;
                    coldError = null;
                    return value;
                })
                .finally(() => { inflight = null; });
        }
        try {
            return await inflight;
        } catch (err) {
            if (value !== null) {
                console.warn(`${label}: refreshing from Secrets Manager failed (${err.message}); using the cached value`);
                freshUntil = now() + FAILED_REFRESH_RETRY_MS;
                return value;
            }
            const error = new Error(`${label}: could not read ${secretIdEnv} from Secrets Manager: ${err.message}`);
            if (coldError === null || now() >= coldRetryAt) {
                // One failed fetch starts one backoff window (concurrent callers share it).
                coldFailures += 1;
                const delay = Math.min(COLD_BACKOFF_MAX_MS, COLD_BACKOFF_BASE_MS * 2 ** (coldFailures - 1));
                coldRetryAt = now() + Math.round(delay * (0.5 + 0.5 * random()));
                coldError = error;
            }
            throw error;
        }
    }

    return { get, configured: Boolean(secretId || plain), fromSecret: Boolean(secretId) };
}

module.exports = {
    createSecretSource,
    getSecretValue,
    extractKey,
    signV4,
    secretsManagerUrl,
    parseSecretArn,
};
