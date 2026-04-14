'use strict';

const { geoAlbersUsa, geoPath } = require('d3-geo');
const topojson = require('topojson-client');
const us = require('us-atlas/states-10m.json');
const sharp = require('sharp');

const STATE_FIPS = {
  alabama: '01', alaska: '02', arizona: '04', arkansas: '05',
  california: '06', colorado: '08', connecticut: '09', delaware: '10',
  florida: '12', georgia: '13', hawaii: '15', idaho: '16',
  illinois: '17', indiana: '18', iowa: '19', kansas: '20',
  kentucky: '21', louisiana: '22', maine: '23', maryland: '24',
  massachusetts: '25', michigan: '26', minnesota: '27', mississippi: '28',
  missouri: '29', montana: '30', nebraska: '31', nevada: '32',
  newhampshire: '33', newjersey: '34', newmexico: '35', newyork: '36',
  northcarolina: '37', northdakota: '38', ohio: '39', oklahoma: '40',
  oregon: '41', pennsylvania: '42', rhodeisland: '44', southcarolina: '45',
  southdakota: '46', tennessee: '47', texas: '48', utah: '49',
  vermont: '50', virginia: '51', washington: '53', westvirginia: '54',
  wisconsin: '55', wyoming: '56',
};

const MAP_W = 960;
const MAP_H = 600;
const TITLE_H = 72;
const TOTAL_H = MAP_H + TITLE_H;

async function generateRoadTripMap(highway, stateNames) {
  const states = topojson.feature(us, us.objects.states);
  const highlightFips = new Set(stateNames.map(s => STATE_FIPS[s]).filter(Boolean));

  // Fit projection to the highlighted states with padding
  const highlightedCollection = {
    type: 'FeatureCollection',
    features: states.features.filter(f => highlightFips.has(String(f.id).padStart(2, '0'))),
  };
  const padding = 40;
  const projection = geoAlbersUsa()
    .fitExtent([[padding, padding], [MAP_W - padding, MAP_H - padding]], highlightedCollection);
  const path = geoPath().projection(projection);

  const statePaths = states.features.map(feature => {
    const fips = String(feature.id).padStart(2, '0');
    const highlighted = highlightFips.has(fips);
    const d = path(feature);
    if (!d) return '';
    const fill = highlighted ? '#c0634a' : '#b5a48a';
    return `<path d="${d}" fill="${fill}" stroke="#c8b99a" stroke-width="0.8"/>`;
  }).join('');

  // Load pre-fetched route geometry if available
  let routePath = '';
  try {
    const routeFeature = require(`./highway-routes/${highway}.json`);
    const d = path(routeFeature);
    if (d) routePath = `<path d="${d}" fill="none" stroke="#1e3a5f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
  } catch {}

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_W}" height="${TOTAL_H}">
  <rect width="${MAP_W}" height="${TOTAL_H}" fill="#c8b99a"/>
  <g transform="translate(0, ${TITLE_H})">${statePaths}${routePath}</g>
  <rect width="${MAP_W}" height="${TITLE_H}" fill="#b5a48a"/>
  <text
    x="${MAP_W / 2}"
    y="${TITLE_H - 20}"
    text-anchor="middle"
    font-family="Arial, sans-serif"
    font-size="32"
    font-weight="bold"
    fill="#1e293b"
    letter-spacing="1"
  >${highway} Road Trip</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateRoadTripMap };
