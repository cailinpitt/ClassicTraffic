const LaunchDarkly = require('@launchdarkly/node-server-sdk');
const keys = require('./keys');

const stateName = process.argv[2];
if (!stateName) {
    console.error('Usage: node check-flag.js <state>');
    process.exit(1);
}

if (!keys.launchDarklyKey) {
    // No key configured, default to enabled
    process.exit(0);
}

const TIMEOUT_MS = 5000;

async function checkFlag() {
    const client = LaunchDarkly.init(keys.launchDarklyKey);

    const timeout = setTimeout(() => {
        console.error('LaunchDarkly timeout, defaulting to enabled');
        client.close();
        process.exit(0);
    }, TIMEOUT_MS);

    try {
        await client.waitForInitialization({ timeout: TIMEOUT_MS / 1000 });

        const context = { kind: 'user', key: stateName, state: stateName };
        const enabled = await client.variation('state-bot-enabled', context, true);

        clearTimeout(timeout);
        await client.close();

        process.exit(enabled ? 0 : 1);
    } catch (err) {
        clearTimeout(timeout);
        console.error('LaunchDarkly error, defaulting to enabled:', err.message);
        try { await client.close(); } catch (_) {}
        process.exit(0);
    }
}

checkFlag();
