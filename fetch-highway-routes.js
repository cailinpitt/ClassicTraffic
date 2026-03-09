#!/usr/bin/env node
'use strict';

// One-time script to pre-fetch interstate route geometries from Overpass API
// and store them as GeoJSON in ./highway-routes/
// Run: node fetch-highway-routes.js

const Axios = require('axios');
const Fs = require('fs-extra');

const HIGHWAYS = Object.keys(require('./highways.json'));
const DELAY_BETWEEN_MS = 8000;
const MAX_RETRIES = 5;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Chain loose way segments into a single continuous line.
// First pass: snap endpoints within SNAP_DIST.
// Second pass: bridge any remaining gaps by connecting nearest endpoints,
// filling OSM data gaps (e.g. concurrent sections not in route relations).
function chainSegments(lines) {
  if (lines.length === 0) return lines;

  const SNAP_DIST = 0.005; // ~500m for snapping true adjacent ways
  const MAX_BRIDGE = 2.0;  // ~200km max bridge (skip truly separate routes)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // Pass 1: snap-chain by endpoint proximity
  const remaining = lines.map(l => [...l]);
  const chained = [];

  while (remaining.length > 0) {
    let current = remaining.shift();
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        const curEnd = current[current.length - 1];
        const curStart = current[0];
        if (dist(curEnd, seg[0]) < SNAP_DIST) {
          current = current.concat(seg.slice(1));
        } else if (dist(curEnd, seg[seg.length - 1]) < SNAP_DIST) {
          current = current.concat([...seg].reverse().slice(1));
        } else if (dist(curStart, seg[seg.length - 1]) < SNAP_DIST) {
          current = seg.concat(current.slice(1));
        } else if (dist(curStart, seg[0]) < SNAP_DIST) {
          current = [...seg].reverse().concat(current.slice(1));
        } else {
          continue;
        }
        remaining.splice(i, 1);
        merged = true;
        break;
      }
    }
    chained.push(current);
  }

  // Pass 2: bridge remaining gaps by connecting nearest endpoints
  while (chained.length > 1) {
    let bestDist = Infinity, bestI = -1, bestJ = -1, bestIEnd = false, bestJEnd = false;
    for (let i = 0; i < chained.length; i++) {
      for (let j = i + 1; j < chained.length; j++) {
        const iStart = chained[i][0], iEnd = chained[i][chained[i].length - 1];
        const jStart = chained[j][0], jEnd = chained[j][chained[j].length - 1];
        const candidates = [
          { d: dist(iEnd, jStart),   iEnd: true,  jEnd: false },
          { d: dist(iEnd, jEnd),     iEnd: true,  jEnd: true  },
          { d: dist(iStart, jStart), iEnd: false, jEnd: false },
          { d: dist(iStart, jEnd),   iEnd: false, jEnd: true  },
        ];
        for (const c of candidates) {
          if (c.d < bestDist) {
            bestDist = c.d; bestI = i; bestJ = j; bestIEnd = c.iEnd; bestJEnd = c.jEnd;
          }
        }
      }
    }
    if (bestDist > MAX_BRIDGE) break;
    let a = chained[bestI];
    let b = chained[bestJ];
    if (!bestIEnd) a = [...a].reverse();
    if (bestJEnd) b = [...b].reverse();
    chained[bestI] = a.concat(b);
    chained.splice(bestJ, 1);
  }

  return chained;
}

async function fetchHighwayRoute(highway) {
  const ref = highway.replace('I-', '');
  const query = `[out:json][timeout:90];relation["network"="US:I"]["ref"="${ref}"]["route"="road"];out geom;`;

  const response = await Axios.post('https://overpass-api.de/api/interpreter', query, {
    headers: { 'Content-Type': 'text/plain' },
    timeout: 120000,
  });

  const lines = [];
  for (const el of response.data.elements) {
    if (el.type !== 'relation') continue;
    for (const member of el.members || []) {
      if (member.type !== 'way' || !member.geometry || member.geometry.length < 2) continue;
      lines.push(member.geometry.map(p => [p.lon, p.lat]));
    }
  }

  const chained = chainSegments(lines);

  return {
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: chained },
    properties: { highway },
  };
}

async function main() {
  Fs.ensureDirSync('./highway-routes');

  for (const highway of HIGHWAYS) {
    const outPath = `./highway-routes/${highway}.json`;
    if (Fs.existsSync(outPath)) {
      console.log(`${highway}: already cached, skipping`);
      continue;
    }
    process.stdout.write(`Fetching ${highway}... `);

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const feature = await fetchHighwayRoute(highway);
        Fs.writeFileSync(outPath, JSON.stringify(feature));
        const kb = Math.round(Fs.statSync(outPath).size / 1024);
        console.log(`${feature.geometry.coordinates.length} segments (${kb} KB)`);
        success = true;
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          console.log(`FAILED after ${MAX_RETRIES} attempts — ${err.message}`);
        } else {
          const retryDelay = attempt * 10000;
          process.stdout.write(`retrying in ${retryDelay / 1000}s... `);
          await sleep(retryDelay);
        }
      }
    }

    if (success) await sleep(DELAY_BETWEEN_MS);
  }
}

main().catch(console.error);
