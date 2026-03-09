#!/usr/bin/env node
'use strict';

// One-time script to pre-fetch interstate route geometries from Overpass API
// and store them as GeoJSON in ./highway-routes/
// Run: node fetch-highway-routes.js

const Axios = require('axios');
const Fs = require('fs-extra');

const HIGHWAYS = Object.keys(require('./highways.json'));

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

  return {
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: lines },
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
    try {
      const feature = await fetchHighwayRoute(highway);
      Fs.writeFileSync(outPath, JSON.stringify(feature));
      const kb = Math.round(Fs.statSync(outPath).size / 1024);
      console.log(`${feature.geometry.coordinates.length} segments (${kb} KB)`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000)); // be polite to Overpass
  }
}

main().catch(console.error);
