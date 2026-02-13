const { BskyAgent } = require('@atproto/api');
const keys = require('./keys');

// List URIs (derived from bsky.app URLs)
const LIST_RKEY_1 = '3meelfcjki62s'; // exclusive list - only keys.js accounts
const LIST_RKEY_2 = '3mdlagujibh2e'; // inclusive list - add keys.js accounts, keep others

const HANDLE = process.env.BSKY_HANDLE || 'ticketmasterceo.com';
const PASSWORD = process.env.BSKY_PASSWORD;

if (!PASSWORD) {
    console.error('Set BSKY_PASSWORD environment variable');
    process.exit(1);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: HANDLE, password: PASSWORD });
    console.log(`Logged in as ${HANDLE}`);

    const ownerDid = agent.session.did;
    const listUri1 = `at://${ownerDid}/app.bsky.graph.list/${LIST_RKEY_1}`;
    const listUri2 = `at://${ownerDid}/app.bsky.graph.list/${LIST_RKEY_2}`;

    // Resolve DIDs for all accounts in keys.js
    const accountEntries = Object.entries(keys.accounts);
    console.log(`\nResolving ${accountEntries.length} account DIDs...`);

    const targetDids = new Map(); // did -> handle
    for (const [name, { identifier }] of accountEntries) {
        try {
            const res = await agent.resolveHandle({ handle: identifier });
            targetDids.set(res.data.did, identifier);
            console.log(`  ${name}: ${identifier} -> ${res.data.did}`);
            await sleep(50);
        } catch (err) {
            console.error(`  Failed to resolve ${identifier}: ${err.message}`);
        }
    }

    console.log(`\nResolved ${targetDids.size} accounts`);

    // Get current members of both lists
    async function getListMembers(listUri) {
        const members = new Map(); // did -> { uri (listitem record uri) }
        let cursor;
        do {
            const res = await agent.app.bsky.graph.getList({
                list: listUri,
                limit: 100,
                cursor,
            });
            for (const item of res.data.items) {
                members.set(item.subject.did, { uri: item.uri });
            }
            cursor = res.data.cursor;
        } while (cursor);
        return members;
    }

    console.log('\nFetching list 1 members...');
    const list1Members = await getListMembers(listUri1);
    console.log(`List 1 has ${list1Members.size} current members`);

    console.log('Fetching list 2 members...');
    const list2Members = await getListMembers(listUri2);
    console.log(`List 2 has ${list2Members.size} current members`);

    // List 1: add missing accounts, remove accounts not in keys.js
    console.log('\n--- List 1 (exclusive) ---');

    // Add missing
    let added1 = 0;
    for (const [did, handle] of targetDids) {
        if (!list1Members.has(did)) {
            console.log(`  Adding ${handle}`);
            await agent.app.bsky.graph.listitem.create(
                { repo: ownerDid },
                { subject: did, list: listUri1, createdAt: new Date().toISOString() }
            );
            added1++;
            await sleep(100);
        }
    }

    // Remove accounts not in keys.js
    let removed1 = 0;
    for (const [did, { uri }] of list1Members) {
        if (!targetDids.has(did)) {
            const rkey = uri.split('/').pop();
            console.log(`  Removing ${did} (rkey: ${rkey})`);
            await agent.app.bsky.graph.listitem.delete(
                { repo: ownerDid, rkey }
            );
            removed1++;
            await sleep(100);
        }
    }

    console.log(`List 1: added ${added1}, removed ${removed1}`);

    // List 2: only add missing accounts (keep existing)
    console.log('\n--- List 2 (inclusive) ---');

    let added2 = 0;
    for (const [did, handle] of targetDids) {
        if (!list2Members.has(did)) {
            console.log(`  Adding ${handle}`);
            await agent.app.bsky.graph.listitem.create(
                { repo: ownerDid },
                { subject: did, list: listUri2, createdAt: new Date().toISOString() }
            );
            added2++;
            await sleep(100);
        }
    }

    console.log(`List 2: added ${added2}`);
    console.log('\nDone!');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
