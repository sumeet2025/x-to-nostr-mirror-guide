'use strict';
// Minimal X API v2 client (read-only). Requires a developer app Bearer token from developer.x.com.
// An X username/password or any Grok Bot access does NOT work here.
const POST_FIELDS = 'created_at,public_metrics,author_id,lang,conversation_id,entities,attachments,referenced_tweets,note_tweet';
const EXPANSIONS = 'attachments.media_keys,referenced_tweets.id,author_id,referenced_tweets.id.author_id';
const MEDIA_FIELDS = 'url,preview_image_url,type,variants';

class XApiError extends Error {
  constructor(msg, status, retryAfterMs) { super(msg); this.status = status; this.retryAfterMs = retryAfterMs; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class XClient {
  constructor({ bearer, fetchImpl = globalThis.fetch, baseUrl = 'https://api.x.com', maxRetries = 3, sleepFn = sleep, maxWaitMs = 15 * 60 * 1000 }) {
    if (!bearer || typeof bearer !== 'string') throw new Error('X Bearer token missing');
    const u = new URL(baseUrl);
    const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' && u.hostname === 'api.x.com') && !(loop && u.protocol === 'http:')) throw new Error('Refusing non-X API base URL');
    Object.assign(this, { bearer, fetchImpl, baseUrl: u.origin, maxRetries, sleepFn, maxWaitMs });
    this.calls = 0;
  }
  async get(path, params = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let attempt = 0;
    for (;;) {
      this.calls++;
      let res;
      try {
        res = await this.fetchImpl(url.toString(), { headers: { Authorization: 'Bearer ' + this.bearer, 'User-Agent': 'x-nostr-mirror/0.1' } });
      } catch (e) {
        if (attempt++ >= this.maxRetries) throw new XApiError('Network error: ' + e.message, 0);
        await this.sleepFn(1000 * 2 ** attempt); continue;
      }
      if (res.status === 200) return res.json();
      const body = await res.text().catch(() => '');
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-rate-limit-reset'));
        const wait = reset ? Math.max(1000, reset * 1000 - Date.now()) : 60000 * (attempt + 1);
        if (attempt++ >= this.maxRetries || wait > this.maxWaitMs) throw new XApiError('X API rate limit hit; try again later', 429, wait);
        await this.sleepFn(wait); continue;
      }
      if (res.status >= 500 && attempt++ < this.maxRetries) { await this.sleepFn(2000 * 2 ** attempt); continue; }
      if (res.status === 401) throw new XApiError('X API rejected the Bearer token (401)', 401);
      if (res.status === 403) throw new XApiError('X API access forbidden (403) - your developer plan may not include this endpoint. ' + body.slice(0, 200), 403);
      throw new XApiError(`X API error ${res.status}: ${body.slice(0, 200)}`, res.status);
    }
  }
  async lookupUser(handle) {
    const h = String(handle).trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').split(/[/?#]/)[0];
    if (!/^\w{1,15}$/.test(h)) throw new Error('Invalid X handle');
    const j = await this.get(`/2/users/by/username/${h}`, { 'user.fields': 'name,username,profile_image_url,description' });
    if (!j.data) throw new Error('X user not found: @' + h);
    return j.data;
  }
  userPostsPage(userId, { sinceId, paginationToken, maxResults = 100, startTime, endTime } = {}) {
    if (sinceId && (startTime || endTime)) throw new Error('since_id cannot be combined with a date range');
    if (!/^\d+$/.test(String(userId))) throw new Error('Invalid user id');
    return this.get(`/2/users/${userId}/tweets`, {
      max_results: maxResults, since_id: sinceId, pagination_token: paginationToken, start_time: startTime, end_time: endTime,
      'tweet.fields': POST_FIELDS, expansions: EXPANSIONS, 'media.fields': MEDIA_FIELDS, 'user.fields': 'username',
    });
  }
  // Fetch all pages newer than sinceId (or full history the API allows when sinceId is null).
  async fetchAllSince(userId, sinceId, { maxPages = 40, onPage, startTime, endTime } = {}) {
    const pages = [];
    let token;
    for (let i = 0; i < maxPages; i++) {
      const p = await this.userPostsPage(userId, { sinceId, paginationToken: token, startTime, endTime });
      pages.push(p);
      if (onPage) await onPage(p, i);
      token = p.meta && p.meta.next_token;
      if (!token) return { pages, complete: true };
    }
    return { pages, complete: false };
  }
}
module.exports = { XClient, XApiError };
