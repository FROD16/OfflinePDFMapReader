import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node tools/validate-geopdf.mjs /path/to/file.pdf");
  process.exit(2);
}

const bytes = fs.readFileSync(file);
const text = Buffer.from(bytes).toString("latin1");
const geoMarker = text.indexOf("/Subtype /GEO");
if (geoMarker < 0) throw new Error("No /Measure /GEO dictionary found.");
const segment = text.slice(Math.max(0, geoMarker - 2500), Math.min(text.length, geoMarker + 14000));
const nums = (s) => (s.match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) || []).map(Number);
const bbox = nums(segment.match(/\/BBox\s*\[\s*([^\]]+)\]/)?.[1] || "");
const gpts = nums(segment.match(/\/GPTS\s*\[\s*([^\]]+)\]/)?.[1] || "");
const lpts = nums(segment.match(/\/LPTS\s*\[\s*([^\]]+)\]/)?.[1] || "");
const crs = segment.match(/\/WKT\s*\(\s*PROJCS\["([^"]+)"/)?.[1] || "unknown";
if (bbox.length < 4 || gpts.length < 8 || lpts.length < 8) throw new Error("Incomplete GEO registration.");
console.log(JSON.stringify({ bytes: bytes.byteLength, bbox, gpts, lpts, crs }, null, 2));
