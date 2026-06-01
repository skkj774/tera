const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const csvPath = path.join(rootDir, "data", "temples.csv");
const jsonPath = path.join(rootDir, "data", "temples.json");
const jsPath = path.join(rootDir, "temples-db.js");
const cachePath = path.join(rootDir, "data", "geocode-cache.json");

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const limit = Number(args.get("limit") || 50);
const delayMs = Number(args.get("delay") || 1400);
const fetchTimeoutMs = Number(args.get("timeout") || 20000);
const useNominatim = args.get("nominatim") === "1";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [rawHeaders, ...records] = rows;
  const headers = rawHeaders.map((header) => header.replace(/^\uFEFF/, ""));
  return records
    .filter((record) => record.some(Boolean))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ""])));
}

function stringifyCsv(rows) {
  const headers = ["name", "location", "latitude", "longitude"];
  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => quoteCsv(row[header] || "")).join(","));
  }

  return `${lines.join("\r\n")}\r\n`;
}

function quoteCsv(value) {
  const text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasCoordinates(row) {
  if (row.latitude === "" || row.longitude === "" || row.latitude === null || row.longitude === null) {
    return false;
  }

  return Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude));
}

function hasUsefulLocation(row) {
  const location = row.location || "";
  if (location.length < 6) return false;
  if (!/[\u90fd\u9053\u5e9c\u770c\u5e02\u533a\u753a\u6751]/.test(location)) return false;

  return /[\d\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u4e01\u76ee\u756a\u53f7\u5b57]/.test(location);
}

function loadCache() {
  if (!fs.existsSync(cachePath)) return {};
  return JSON.parse(fs.readFileSync(cachePath, "utf8"));
}

function saveCache(cache) {
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function cacheKey(row) {
  return `${row.name}|${row.location}`;
}

function buildQueries(row) {
  const name = row.name.replace(/\s*\(.+?\)\s*$/, "").trim();
  const location = row.location.trim();
  return Array.from(new Set([
    `${name} ${location}`,
    location
  ].filter(Boolean)));
}

async function searchNominatim(query) {
  const params = new URLSearchParams({
    format: "jsonv2",
    q: query,
    countrycodes: "jp",
    "accept-language": "ja",
    limit: "1"
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
    headers: {
      "User-Agent": "TeraWalk/1.0 (local app data build; skkj774.github.io/tera)"
    }
  });

  if (!response.ok) {
    throw new Error(`Nominatim returned ${response.status}`);
  }

  const places = await response.json();
  return places[0] || null;
}

async function searchGsiAddress(query) {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?${params}`, {
    signal: AbortSignal.timeout(fetchTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`GSI address search returned ${response.status}`);
  }

  const places = await response.json();
  const coordinates = places[0]?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  return {
    latitude: String(Number(coordinates[1])),
    longitude: String(Number(coordinates[0]))
  };
}

async function geocode(row) {
  const gsiPlace = await searchGsiAddress(row.location.trim());
  if (gsiPlace) return gsiPlace;
  if (!useNominatim) return null;

  for (const query of buildQueries(row)) {
    const place = await searchNominatim(query);
    if (!place) continue;

    return {
      latitude: String(Number(place.lat)),
      longitude: String(Number(place.lon))
    };
  }

  return null;
}

function writeDatabase(rows) {
  const json = JSON.stringify(rows);
  fs.writeFileSync(csvPath, stringifyCsv(rows), "utf8");
  fs.writeFileSync(jsonPath, json, "utf8");
  fs.writeFileSync(jsPath, `window.templeDatabase = ${json};`, "utf8");
}

async function main() {
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const cache = loadCache();
  const targets = rows
    .filter((row) => !hasCoordinates(row) && hasUsefulLocation(row) && cache[cacheKey(row)] !== null)
    .slice(0, limit);
  let updated = 0;
  let missed = 0;

  for (const row of targets) {
    const key = cacheKey(row);

    try {
      if (!(key in cache)) {
        cache[key] = await geocode(row);
        saveCache(cache);
        await sleep(delayMs);
      }

      if (cache[key]) {
        row.latitude = cache[key].latitude;
        row.longitude = cache[key].longitude;
        updated += 1;
      } else {
        missed += 1;
      }
    } catch (error) {
      console.error(`${row.name} / ${row.location}: ${error.message}`);
      missed += 1;
      await sleep(delayMs);
    }
  }

  writeDatabase(rows);

  const totalWithCoordinates = rows.filter(hasCoordinates).length;
  console.log(`checked=${targets.length} updated=${updated} missed=${missed} coords=${totalWithCoordinates}/${rows.length}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
