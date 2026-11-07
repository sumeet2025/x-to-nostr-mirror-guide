'use strict';
// Generated fake data only. Snowflake-like ids encode time so thread heuristics work.
const EPOCH = 1288834974657n;
const idAt = (iso, seq = 0) => String(((BigInt(Date.parse(iso)) - EPOCH) << 22n) + BigInt(seq));
const SRC = '1000000000000000001';
const OTHER = '2000000000000000002';
function post(iso, text, extra = {}) { return { id: idAt(iso), created_at: new Date(iso).toISOString(), author_id: SRC, text, ...extra }; }
function fakeTimeline() {
  const a = post('2024-01-01T10:00:00Z', 'Hello world https://t.co/abc', { entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.org/page' }] } });
  const b = post('2024-01-01T10:01:00Z', '@fake second in thread', { referenced_tweets: [{ type: 'replied_to', id: a.id }] });
  const c = post('2024-01-01T10:02:00Z', '@fake third in thread', { referenced_tweets: [{ type: 'replied_to', id: b.id }] });
  const otherTweet = { id: idAt('2023-12-31T09:00:00Z'), author_id: OTHER, text: 'someone else', created_at: '2023-12-31T09:00:00.000Z' };
  const rt = post('2024-01-02T09:00:00Z', 'RT @other: someone else', { referenced_tweets: [{ type: 'retweeted', id: otherTweet.id }] });
  const rep = post('2024-01-02T10:00:00Z', '@other I disagree', { referenced_tweets: [{ type: 'replied_to', id: otherTweet.id }] });
  const q = post('2024-01-03T10:00:00Z', 'Look at this https://t.co/q1', { referenced_tweets: [{ type: 'quoted', id: otherTweet.id }], entities: { urls: [{ url: 'https://t.co/q1', expanded_url: `https://x.com/other/status/${otherTweet.id}` }] } });
  const m = post('2024-01-04T10:00:00Z', 'Photo https://t.co/ph', { attachments: { media_keys: ['3_1'] }, entities: { urls: [{ url: 'https://t.co/ph', expanded_url: 'https://x.com/fake/status/1/photo/1', media_key: '3_1' }] } });
  const deletedHead = idAt('2024-01-05T10:00:00Z');
  const orphan = post('2024-01-05T10:00:30Z', '@fake orphan thread', { referenced_tweets: [{ type: 'replied_to', id: deletedHead }] });
  const page = { data: [m, q, rep, rt, c, b, a, orphan].sort((x, y) => (BigInt(y.id) > BigInt(x.id) ? 1 : -1)),
    includes: { media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/fake.jpg' }], tweets: [otherTweet], users: [{ id: OTHER, username: 'other' }] }, meta: {} };
  return { a, b, c, rt, rep, q, m, orphan, otherTweet, page };
}
const JOB = { id: 'job-test01', name: 'test', sourceUserId: SRC, sourceUsername: 'fake', relays: ['ws://127.0.0.1:1'], minRelayOk: 2, timestampMode: 'original', policy: {} };
module.exports = { idAt, SRC, OTHER, fakeTimeline, JOB };
