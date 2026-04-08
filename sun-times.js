#!/usr/bin/env node
// Outputs sunrise and sunset times for a given lat/lng in HH:MM 24h format (local time).
// Usage: node sun-times.js <latitude> <longitude> <timezone>
// Example: node sun-times.js 41.8781 -87.6298 America/Chicago

const [,, lat, lng, tz] = process.argv;

if (!lat || !lng || !tz) {
  console.error('Usage: node sun-times.js <latitude> <longitude> <timezone>');
  process.exit(1);
}

// Standard NOAA sunrise/sunset algorithm
function sunTime(date, lat, lng, isSunrise) {
  const rad = Math.PI / 180;
  const deg = 1 / rad;

  const JD = Math.floor(date.getTime() / 86400000) + 2440587.5;
  const n = Math.ceil(JD - 2451545.0 + 0.0008);
  const Js = n - lng / 360;
  const M = (357.5291 + 0.98560028 * Js) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const sinDec = Math.sin(lambda * rad) * Math.sin(23.4397 * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinDec) / (Math.cos(lat * rad) * cosDec);

  if (cosH < -1 || cosH > 1) return null; // polar day/night

  const H = Math.acos(cosH) * deg;
  const Jx = Jt + (isSunrise ? -H : H) / 360;
  const ms = (Jx - 2440587.5) * 86400000;
  return new Date(ms);
}

function toHHMM(date, tz) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz,
  });
}

const today = new Date();
const rise = sunTime(today, parseFloat(lat), parseFloat(lng), true);
const set  = sunTime(today, parseFloat(lat), parseFloat(lng), false);

if (!rise || !set) {
  console.error('Could not compute sun times (polar day/night?)');
  process.exit(1);
}

console.log(`SUNRISE=${toHHMM(rise, tz)}`);
console.log(`SUNSET=${toHHMM(set, tz)}`);
