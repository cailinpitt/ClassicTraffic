const { AtpAgent } = require('@atproto/api');
const keys = require('./keys.js');
const Fs = require('fs-extra');
const sharp = require('sharp');

const FOLLOW_HANDLE = 'ticketmasterceo.com';

// Map account names to state abbreviations and display names
const STATE_MAP = {
  ohio: { abbrev: 'OH', name: 'Ohio' },
  montana: { abbrev: 'MT', name: 'Montana' },
  nevada: { abbrev: 'NV', name: 'Nevada' },
  florida: { abbrev: 'FL', name: 'Florida' },
  wisconsin: { abbrev: 'WI', name: 'Wisconsin' },
  utah: { abbrev: 'UT', name: 'Utah' },
  idaho: { abbrev: 'ID', name: 'Idaho' },
  connecticut: { abbrev: 'CT', name: 'Connecticut' },
  newyork: { abbrev: 'NY', name: 'New York' },
  delaware: { abbrev: 'DE', name: 'Delaware' },
  alabama: { abbrev: 'AL', name: 'Alabama' },
  georgia: { abbrev: 'GA', name: 'Georgia' },
  southcarolina: { abbrev: 'SC', name: 'South Carolina' },
  northcarolina: { abbrev: 'NC', name: 'North Carolina' },
  tennessee: { abbrev: 'TN', name: 'Tennessee' },
  arkansas: { abbrev: 'AR', name: 'Arkansas' },
  arizona: { abbrev: 'AZ', name: 'Arizona' },
  oklahoma: { abbrev: 'OK', name: 'Oklahoma' },
  alaska: { abbrev: 'AK', name: 'Alaska' },
  hawaii: { abbrev: 'HI', name: 'Hawaii' },
  indiana: { abbrev: 'IN', name: 'Indiana' },
  iowa: { abbrev: 'IA', name: 'Iowa' },
  kansas: { abbrev: 'KS', name: 'Kansas' },
  maine: { abbrev: 'ME', name: 'Maine' },
  california: { abbrev: 'CA', name: 'California' },
  colorado: { abbrev: 'CO', name: 'Colorado' },
  illinois: { abbrev: 'IL', name: 'Illinois' },
  kentucky: { abbrev: 'KY', name: 'Kentucky' },
  louisiana: { abbrev: 'LA', name: 'Louisiana' },
  maryland: { abbrev: 'MD', name: 'Maryland' },
  massachusetts: { abbrev: 'MA', name: 'Massachusetts' },
  michigan: { abbrev: 'MI', name: 'Michigan' },
  minnesota: { abbrev: 'MN', name: 'Minnesota' },
  mississippi: { abbrev: 'MS', name: 'Mississippi' },
  missouri: { abbrev: 'MO', name: 'Missouri' },
  nebraska: { abbrev: 'NE', name: 'Nebraska' },
  newhampshire: { abbrev: 'NH', name: 'New Hampshire' },
  newjersey: { abbrev: 'NJ', name: 'New Jersey' },
  newmexico: { abbrev: 'NM', name: 'New Mexico' },
  northdakota: { abbrev: 'ND', name: 'North Dakota' },
  oregon: { abbrev: 'OR', name: 'Oregon' },
  pennsylvania: { abbrev: 'PA', name: 'Pennsylvania' },
  rhodeisland: { abbrev: 'RI', name: 'Rhode Island' },
  southdakota: { abbrev: 'SD', name: 'South Dakota' },
  texas: { abbrev: 'TX', name: 'Texas' },
  vermont: { abbrev: 'VT', name: 'Vermont' },
  virginia: { abbrev: 'VA', name: 'Virginia' },
  washington: { abbrev: 'WA', name: 'Washington' },
  westvirginia: { abbrev: 'WV', name: 'West Virginia' },
  wyoming: { abbrev: 'WY', name: 'Wyoming' },
};

function extractStatePaths(svgContent, stateAbbrev) {
  // Handle <g> groups (Michigan has two paths in a group)
  const groupRegex = new RegExp(
    `<g[^>]*id="${stateAbbrev}"[^>]*class="state"[^>]*>([\\s\\S]*?)</g>`,
    'i'
  );
  const groupMatch = svgContent.match(groupRegex);

  if (groupMatch) {
    const pathRegex = /\bd="([^"]+)"/g;
    const paths = [];
    let m;
    while ((m = pathRegex.exec(groupMatch[1])) !== null) {
      paths.push(m[1]);
    }
    return paths;
  }

  // Handle single <path> elements
  const pathRegex = new RegExp(
    `<path[^>]*id="${stateAbbrev}"[^>]*class="state"[^>]*\\bd="([^"]+)"`,
    'i'
  );
  let match = svgContent.match(pathRegex);
  if (match) return [match[1]];

  // Try alternate attribute order (d before id)
  const altRegex = new RegExp(
    `<path[^>]*\\bd="([^"]+)"[^>]*id="${stateAbbrev}"[^>]*class="state"`,
    'i'
  );
  match = svgContent.match(altRegex);
  if (match) return [match[1]];

  return null;
}

function getPathBounds(pathData) {
  // Parse SVG path to find bounding box
  const coords = [];
  const numberPattern = /-?\d+\.?\d*/g;

  // Split by commands
  const commands = pathData.match(/[MLHVCSQTAZmlhvcsqtaz][^MLHVCSQTAZmlhvcsqtaz]*/g) || [];

  let x = 0, y = 0;

  for (const cmd of commands) {
    const type = cmd[0];
    const nums = (cmd.slice(1).match(numberPattern) || []).map(Number);

    switch (type) {
      case 'M':
      case 'L':
        for (let i = 0; i < nums.length; i += 2) {
          x = nums[i]; y = nums[i + 1];
          coords.push({ x, y });
        }
        break;
      case 'm':
      case 'l':
        for (let i = 0; i < nums.length; i += 2) {
          x += nums[i]; y += nums[i + 1];
          coords.push({ x, y });
        }
        break;
      case 'H': x = nums[0]; coords.push({ x, y }); break;
      case 'h': x += nums[0]; coords.push({ x, y }); break;
      case 'V': y = nums[0]; coords.push({ x, y }); break;
      case 'v': y += nums[0]; coords.push({ x, y }); break;
      case 'C':
        for (let i = 0; i < nums.length; i += 6) {
          coords.push({ x: nums[i], y: nums[i + 1] });
          coords.push({ x: nums[i + 2], y: nums[i + 3] });
          x = nums[i + 4]; y = nums[i + 5];
          coords.push({ x, y });
        }
        break;
      case 'c':
        for (let i = 0; i < nums.length; i += 6) {
          coords.push({ x: x + nums[i], y: y + nums[i + 1] });
          coords.push({ x: x + nums[i + 2], y: y + nums[i + 3] });
          x += nums[i + 4]; y += nums[i + 5];
          coords.push({ x, y });
        }
        break;
      case 'S':
        for (let i = 0; i < nums.length; i += 4) {
          coords.push({ x: nums[i], y: nums[i + 1] });
          x = nums[i + 2]; y = nums[i + 3];
          coords.push({ x, y });
        }
        break;
      case 's':
        for (let i = 0; i < nums.length; i += 4) {
          coords.push({ x: x + nums[i], y: y + nums[i + 1] });
          x += nums[i + 2]; y += nums[i + 3];
          coords.push({ x, y });
        }
        break;
      default:
        break;
    }
  }

  if (coords.length === 0) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  return {
    minX: Math.min(...coords.map(c => c.x)),
    minY: Math.min(...coords.map(c => c.y)),
    maxX: Math.max(...coords.map(c => c.x)),
    maxY: Math.max(...coords.map(c => c.y)),
  };
}

function createStateSvg(paths) {
  // Get combined bounds across all paths
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    const b = getPathBounds(p);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const padding = Math.max(width, height) * 0.15;

  const vbX = minX - padding;
  const vbY = minY - padding;
  const vbW = width + padding * 2;
  const vbH = height + padding * 2;

  const pathElements = paths
    .map(d => `    <path d="${d}" fill="#4a90d9" stroke="#3a7bc8" stroke-width="1.5"/>`)
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="500" height="500">
  <rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="white"/>
${pathElements}
</svg>`;
}

async function generateStateAvatar(svgContent, stateAbbrev, outputPath) {
  const paths = extractStatePaths(svgContent, stateAbbrev);
  if (!paths || paths.length === 0) {
    console.log(`  WARNING: Could not extract path for ${stateAbbrev}`);
    return false;
  }

  const stateSvg = createStateSvg(paths);
  const pngBuffer = await sharp(Buffer.from(stateSvg))
    .resize(500, 500, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();

  Fs.writeFileSync(outputPath, pngBuffer);
  return true;
}

async function updateAccount(accountName, stateInfo, svgContent) {
  const account = keys.accounts[accountName];
  if (!account) {
    console.log(`  SKIP: No credentials for ${accountName}`);
    return;
  }

  console.log(`\n--- ${stateInfo.name} (${account.identifier}) ---`);

  const agent = new AtpAgent({ service: keys.service });
  await agent.login({
    identifier: account.identifier,
    password: account.password,
  });

  const did = agent.session?.did;
  if (!did) {
    console.log('  ERROR: Failed to login');
    return;
  }

  // 1. Update profile description and avatar
  const avatarDir = './avatars';
  Fs.ensureDirSync(avatarDir);
  const avatarPath = `${avatarDir}/${stateInfo.abbrev}.png`;

  let avatarBlob = null;
  const avatarGenerated = await generateStateAvatar(svgContent, stateInfo.abbrev, avatarPath);
  if (avatarGenerated) {
    const avatarData = Fs.readFileSync(avatarPath);
    const uploadResponse = await agent.uploadBlob(avatarData, { encoding: 'image/png' });
    avatarBlob = uploadResponse.data.blob;
    console.log(`  Uploaded avatar for ${stateInfo.abbrev}`);
  }

  const description = `Posts videos from ${stateInfo.name} traffic cameras`;

  await agent.upsertProfile((existing) => {
    const updated = { ...existing };
    updated.description = description;
    if (avatarBlob) {
      updated.avatar = avatarBlob;
    }
    return updated;
  });
  console.log(`  Profile updated: "${description}"`);

  // 2. Handle follows - follow ticketmasterceo.com, unfollow everyone else
  // Resolve the target DID
  const targetProfile = await agent.resolveHandle({ handle: FOLLOW_HANDLE });
  const targetDid = targetProfile.data.did;

  // Get current follows
  let follows = [];
  let cursor;
  do {
    const resp = await agent.getFollows({ actor: did, limit: 100, cursor });
    follows = follows.concat(resp.data.follows);
    cursor = resp.data.cursor;
  } while (cursor);

  console.log(`  Current follows: ${follows.length}`);

  let alreadyFollowing = false;

  for (const follow of follows) {
    if (follow.did === targetDid) {
      alreadyFollowing = true;
      console.log(`  Already following ${FOLLOW_HANDLE}`);
    } else {
      // Need to get the follow record URI to delete it
      const followRecords = await agent.api.com.atproto.repo.listRecords({
        repo: did,
        collection: 'app.bsky.graph.follow',
        limit: 100,
      });

      for (const record of followRecords.data.records) {
        if (record.value.subject === follow.did) {
          await agent.api.com.atproto.repo.deleteRecord({
            repo: did,
            collection: 'app.bsky.graph.follow',
            rkey: record.uri.split('/').pop(),
          });
          console.log(`  Unfollowed ${follow.handle}`);
          break;
        }
      }
    }
  }

  if (!alreadyFollowing) {
    await agent.follow(targetDid);
    console.log(`  Followed ${FOLLOW_HANDLE}`);
  }
}

async function main() {
  console.log('Loading map SVG...');
  const svgContent = Fs.readFileSync('./map.svg', 'utf-8');

  const accountNames = Object.keys(keys.accounts);
  console.log(`Found ${accountNames.length} accounts to update\n`);

  for (const accountName of accountNames) {
    const stateInfo = STATE_MAP[accountName];
    if (!stateInfo) {
      console.log(`\n--- SKIP: No state mapping for "${accountName}" ---`);
      continue;
    }

    try {
      await updateAccount(accountName, stateInfo, svgContent);
    } catch (error) {
      console.error(`  ERROR (${accountName}): ${error.message}`);
    }

    // Small delay between accounts to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n\nDone!');
}

main().catch(console.error);
