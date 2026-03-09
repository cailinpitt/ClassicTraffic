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

// Chain loose way segments into fewer continuous lines by matching endpoints
function chainSegments(lines) {
  if (lines.length === 0) return lines;

  const SNAP_DIST = 0.0001; // ~10m tolerance for connecting endpoints
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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
          remaining.splice(i, 1);
          merged = true;
          break;
        } else if (dist(curEnd, seg[seg.length - 1]) < SNAP_DIST) {
          current = current.concat([...seg].reverse().slice(1));
          remaining.splice(i, 1);
          merged = true;
          break;
        } else if (dist(curStart, seg[seg.length - 1]) < SNAP_DIST) {
          current = seg.concat(current.slice(1));
          remaining.splice(i, 1);
          merged = true;
          break;
        } else if (dist(curStart, seg[0]) < SNAP_DIST) {
          current = [...seg].reverse().concat(current.slice(1));
          remaining.splice(i, 1);
          merged = true;
          break;
        }
      }
    }
    chained.push(current);
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
