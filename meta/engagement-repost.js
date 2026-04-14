const { AtpAgent } = require('@atproto/api');
const keys = require('../keys.js');

const argv = require('minimist')(process.argv.slice(2));
const dryRun = !!argv['dry-run'];

const LOOKBACK_DAYS = 3;
const POST_AGE_MIN_HOURS = 6;
const MIN_LIKES = 3;
const MAX_REPOSTS_PER_RUN = 3;

function score(post) {
  return (post.likeCount || 0) + 2 * (post.repostCount || 0) + 3 * (post.replyCount || 0);
}

async function getExistingRepostSubjects(agent, did) {
  const set = new Set();
  let cursor;
  do {
    const res = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: 'app.bsky.feed.repost',
      limit: 100,
      cursor,
    });
    for (const r of res.data.records) {
      if (r.value?.subject?.uri) set.add(r.value.subject.uri);
    }
    cursor = res.data.cursor;
  } while (cursor);
  return set;
}

async function getRecentPosts(agent, handle, sinceMs) {
  const posts = [];
  let cursor;
  while (true) {
    const res = await agent.app.bsky.feed.getAuthorFeed({
      actor: handle,
      limit: 50,
      cursor,
      filter: 'posts_no_replies',
    });
    for (const item of res.data.feed) {
      if (item.reason) continue;
      const post = item.post;
      const createdAt = new Date(post.record.createdAt).getTime();
      if (createdAt < sinceMs) return posts;
      posts.push(post);
    }
    cursor = res.data.cursor;
    if (!cursor) break;
  }
  return posts;
}

async function run() {
  const meta = keys.accounts.meta;
  if (!meta) throw new Error("Account 'meta' not found in keys.accounts");

  const agent = new AtpAgent({ service: keys.service });
  await agent.login({ identifier: meta.identifier, password: meta.password });
  const metaDid = agent.session.did;

  const alreadyReposted = await getExistingRepostSubjects(agent, metaDid);
  console.log(`Previously reposted: ${alreadyReposted.size}`);

  const cutoffMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const minAgeCutoffMs = Date.now() - POST_AGE_MIN_HOURS * 60 * 60 * 1000;

  const candidates = [];
  for (const [name, account] of Object.entries(keys.accounts)) {
    if (name === 'meta') continue;
    try {
      const posts = await getRecentPosts(agent, account.identifier, cutoffMs);
      for (const p of posts) {
        const created = new Date(p.record.createdAt).getTime();
        if (created > minAgeCutoffMs) continue;
        if (alreadyReposted.has(p.uri)) continue;
        if ((p.likeCount || 0) < MIN_LIKES) continue;
        candidates.push({
          name,
          handle: account.identifier,
          uri: p.uri,
          cid: p.cid,
          score: score(p),
          likes: p.likeCount || 0,
          reposts: p.repostCount || 0,
          replies: p.replyCount || 0,
        });
      }
    } catch (err) {
      console.error(`[${name}] fetch failed: ${err.message}`);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const picks = candidates.slice(0, MAX_REPOSTS_PER_RUN);

  if (picks.length === 0) {
    console.log('No eligible posts to repost');
    return;
  }

  console.log(`\nTop ${picks.length} of ${candidates.length} candidate(s):`);
  for (const p of picks) {
    const rkey = p.uri.split('/').pop();
    const url = `https://bsky.app/profile/${p.handle}/post/${rkey}`;
    console.log(`  [${p.name}] score=${p.score} (${p.likes}L/${p.reposts}R/${p.replies}C) ${url}`);
  }

  if (dryRun) {
    console.log('\n[dry run] Not reposting');
    return;
  }

  for (const p of picks) {
    await agent.repost(p.uri, p.cid);
    console.log(`Reposted ${p.name}`);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
