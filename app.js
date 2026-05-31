const storageKey = "tera.templeRecords";
const userIdStorageKey = "tera.userId";

const form = document.querySelector("#templeForm");
const recordId = document.querySelector("#recordId");
const formTitle = document.querySelector("#formTitle");
const resetButton = document.querySelector("#resetButton");
const searchInput = document.querySelector("#searchInput");
const filterSelect = document.querySelector("#filterSelect");
const sortSelect = document.querySelector("#sortSelect");
const recordsList = document.querySelector("#recordsList");
const emptyState = document.querySelector("#emptyState");
const template = document.querySelector("#recordTemplate");
const templeSuggestions = document.querySelector("#templeSuggestions");
const syncStatus = document.querySelector("#syncStatus");
const locationStatus = document.querySelector("#locationStatus");
const registeredCount = document.querySelector("#registeredCount");

const fields = {
  name: document.querySelector("#name"),
  area: document.querySelector("#area"),
  visitedAt: document.querySelector("#visitedAt"),
  notes: document.querySelector("#notes"),
  photoUrl: document.querySelector("#photoUrl"),
  hasGoshuin: document.querySelector("#hasGoshuin"),
  isFavorite: document.querySelector("#isFavorite")
};

let records = loadRecords();
const templeDatabase = Array.isArray(window.templeDatabase) ? window.templeDatabase : [];
let recordsCollection = null;
let usersCollection = null;
let cloudSyncEnabled = false;
let cloudSyncStarted = false;

function setupTempleDatabase() {
  if (!templeSuggestions || templeDatabase.length === 0) return;
  templeSuggestions.replaceChildren();
}

function updateTempleSuggestions(query) {
  if (!templeSuggestions || templeDatabase.length === 0) return;
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    templeSuggestions.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();

  templeDatabase
    .filter((temple) => {
      return `${temple.name} ${temple.location}`.toLowerCase().includes(normalizedQuery);
    })
    .slice(0, 80)
    .forEach((temple) => {
    const option = document.createElement("option");
    option.value = temple.name;
    option.label = temple.location;
    fragment.append(option);
  });

  templeSuggestions.replaceChildren(fragment);
}

function fillTempleLocation() {
  const selected = templeDatabase.find((temple) => temple.name === fields.name.value.trim());
  if (selected && !fields.area.value.trim()) {
    fields.area.value = selected.location;
  }
}

function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) ?? [];
  } catch {
    return [];
  }
}

function saveLocalRecords() {
  localStorage.setItem(storageKey, JSON.stringify(records));
}

function getCurrentUserId() {
  let userId = localStorage.getItem(userIdStorageKey);
  if (!userId) {
    userId = crypto.randomUUID();
    localStorage.setItem(userIdStorageKey, userId);
  }
  return userId;
}

function hasFirebaseConfig() {
  const config = window.terawalkFirebaseConfig;
  return Boolean(
    config &&
    config.apiKey &&
    config.projectId
  );
}

function setSyncStatus(text) {
  if (syncStatus) syncStatus.textContent = text;
}

function setRegisteredCount(count) {
  if (registeredCount) registeredCount.textContent = String(count);
}

function setLocationStatus(text) {
  if (locationStatus) locationStatus.textContent = text;
}

function replaceLocationStatus(...nodes) {
  if (!locationStatus) return;
  locationStatus.replaceChildren(...nodes);
}

function createTextNode(text) {
  return document.createTextNode(text);
}

function formatCoordinate(value) {
  return value.toFixed(4);
}

function formatNearestAddress(place) {
  if (!place) return "";

  const address = place.address ?? {};
  const buildingName = place.name || address.building || address.amenity || address.shop || "";
  const addressParts = [
    address.province || address.state,
    address.city || address.town || address.village || address.municipality,
    address.suburb || address.neighbourhood || address.quarter,
    address.road,
    address.house_number
  ].filter(Boolean);

  if (buildingName && addressParts.length > 0) {
    return `${buildingName} / ${addressParts.join("")}`;
  }

  return buildingName || addressParts.join("") || place.display_name || "";
}

function toRadians(value) {
  return value * Math.PI / 180;
}

function getDistanceMeters(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const earthRadiusMeters = 6371000;
  const latitudeDelta = toRadians(toLatitude - fromLatitude);
  const longitudeDelta = toRadians(toLongitude - fromLongitude);
  const startLatitude = toRadians(fromLatitude);
  const endLatitude = toRadians(toLatitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getElementCenter(element) {
  if (element.type === "node") {
    return {
      latitude: element.lat,
      longitude: element.lon
    };
  }

  if (element.center) {
    return {
      latitude: element.center.lat,
      longitude: element.center.lon
    };
  }

  return null;
}

function formatOsmElementAddress(element) {
  const tags = element.tags ?? {};
  const name = tags.name || tags["name:ja"] || tags["name:en"] || "";
  const kind = tags.amenity || tags.shop || tags.tourism || tags.office || tags.building || "";
  const addressParts = [
    tags["addr:province"] || tags["addr:state"],
    tags["addr:city"],
    tags["addr:suburb"] || tags["addr:quarter"] || tags["addr:neighbourhood"],
    tags["addr:street"],
    tags["addr:housenumber"]
  ].filter(Boolean);
  const label = name || (kind && kind !== "yes" ? kind : "建物");

  if (addressParts.length > 0) {
    return `${label} / ${addressParts.join("")}`;
  }

  return label;
}

async function fetchOverpassElements(query) {
  const params = new URLSearchParams({ data: query });
  const response = await fetch(`https://overpass-api.de/api/interpreter?${params}`);
  if (!response.ok) throw new Error("Overpass lookup failed");

  const data = await response.json();
  return Array.isArray(data.elements) ? data.elements : [];
}

function findNearestElement(elements, latitude, longitude) {
  return elements
    .map((element) => {
      const center = getElementCenter(element);
      if (!center) return null;
      return {
        element,
        distance: getDistanceMeters(latitude, longitude, center.latitude, center.longitude)
      };
    })
    .filter(Boolean)
    .sort((first, second) => first.distance - second.distance)[0];
}

function findNearestElements(elements, latitude, longitude, limit = 10) {
  const seen = new Set();

  return elements
    .map((element) => {
      const center = getElementCenter(element);
      if (!center) return null;
      const tags = element.tags ?? {};
      const name = tags.name || tags["name:ja"] || tags["name:en"] || "";
      const key = name || `${element.type}:${element.id}`;

      return {
        element,
        key,
        distance: getDistanceMeters(latitude, longitude, center.latitude, center.longitude)
      };
    })
    .filter(Boolean)
    .sort((first, second) => first.distance - second.distance)
    .filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .slice(0, limit);
}

function formatDistance(meters) {
  if (meters >= 1000) return `約${(meters / 1000).toFixed(1)}km`;
  return `約${Math.round(meters)}m`;
}

function formatTempleElement(nearest) {
  if (!nearest) return "";
  const tags = nearest.element.tags ?? {};
  const name = tags.name || tags["name:ja"] || tags["name:en"] || "名称未設定の寺院";
  return `${name}（${formatDistance(nearest.distance)}）`;
}

function formatTempleAddress(element) {
  const tags = element.tags ?? {};
  const addressParts = [
    tags["addr:full"],
    tags["addr:province"] || tags["addr:state"],
    tags["addr:city"],
    tags["addr:suburb"] || tags["addr:quarter"] || tags["addr:neighbourhood"],
    tags["addr:street"],
    tags["addr:housenumber"]
  ].filter(Boolean);

  return addressParts.join("") || "所在地未登録";
}

function createNearestTemplePopup(temples) {
  const wrapper = document.createElement("span");
  wrapper.className = "temple-hover";
  wrapper.tabIndex = 0;

  const nearest = temples[0];
  const nearestLabel = nearest ? formatTempleElement(nearest) : "見つかりません";
  const label = document.createElement("span");
  label.className = "temple-hover-label";
  label.textContent = `最寄りの寺: ${nearestLabel}`;
  wrapper.append(label);

  const popup = document.createElement("span");
  popup.className = "temple-popup";

  const title = document.createElement("span");
  title.className = "temple-popup-title";
  title.textContent = "最寄りの寺 TOP10";
  popup.append(title);

  const list = document.createElement("span");
  list.className = "temple-popup-list";

  if (temples.length === 0) {
    const empty = document.createElement("span");
    empty.className = "temple-popup-empty";
    empty.textContent = "周辺の寺院データが見つかりませんでした";
    list.append(empty);
  }

  temples.forEach((temple, index) => {
    const item = document.createElement("span");
    item.className = "temple-popup-item";
    item.tabIndex = 0;

    const name = document.createElement("span");
    name.className = "temple-popup-name";
    name.textContent = `${index + 1}. ${formatTempleElement(temple)}`;

    const address = document.createElement("span");
    address.className = "temple-address-popup";
    address.textContent = formatTempleAddress(temple.element);

    item.append(name, address);
    list.append(item);
  });

  popup.append(list);
  wrapper.append(popup);

  wrapper.addEventListener("mouseenter", () => wrapper.classList.add("is-open"));
  wrapper.addEventListener("mouseleave", () => wrapper.classList.remove("is-open"));
  wrapper.addEventListener("focusin", () => wrapper.classList.add("is-open"));
  wrapper.addEventListener("focusout", () => wrapper.classList.remove("is-open"));

  return wrapper;
}

async function findNearestOsmElement(latitude, longitude) {
  const query = `
    [out:json][timeout:10];
    (
      node(around:120,${latitude},${longitude})["building"];
      way(around:120,${latitude},${longitude})["building"];
      relation(around:120,${latitude},${longitude})["building"];
      node(around:120,${latitude},${longitude})["amenity"];
      way(around:120,${latitude},${longitude})["amenity"];
      relation(around:120,${latitude},${longitude})["amenity"];
      node(around:120,${latitude},${longitude})["shop"];
      way(around:120,${latitude},${longitude})["shop"];
      relation(around:120,${latitude},${longitude})["shop"];
      node(around:120,${latitude},${longitude})["tourism"];
      way(around:120,${latitude},${longitude})["tourism"];
      relation(around:120,${latitude},${longitude})["tourism"];
    );
    out center tags 40;
  `;
  const elements = await fetchOverpassElements(query);
  const nearest = findNearestElement(elements, latitude, longitude);

  if (!nearest) return "";
  return `${formatOsmElementAddress(nearest.element)}（${formatDistance(nearest.distance)}）`;
}

async function findNearestTemples(latitude, longitude) {
  const query = `
    [out:json][timeout:10];
    (
      node(around:5000,${latitude},${longitude})["amenity"="place_of_worship"]["religion"="buddhist"];
      way(around:5000,${latitude},${longitude})["amenity"="place_of_worship"]["religion"="buddhist"];
      relation(around:5000,${latitude},${longitude})["amenity"="place_of_worship"]["religion"="buddhist"];
      node(around:5000,${latitude},${longitude})["historic"="temple"];
      way(around:5000,${latitude},${longitude})["historic"="temple"];
      relation(around:5000,${latitude},${longitude})["historic"="temple"];
      node(around:5000,${latitude},${longitude})["building"="temple"];
      way(around:5000,${latitude},${longitude})["building"="temple"];
      relation(around:5000,${latitude},${longitude})["building"="temple"];
      node(around:5000,${latitude},${longitude})["amenity"="place_of_worship"]["name"~"寺|院|庵|堂"];
      way(around:5000,${latitude},${longitude})["amenity"="place_of_worship"]["name"~"寺|院|庵|堂"];
      relation(around:5000,${latitude},${longitude})["amenity"="place_of_worship"]["name"~"寺|院|庵|堂"];
    );
    out center tags 80;
  `;
  const elements = await fetchOverpassElements(query);
  return findNearestElements(elements, latitude, longitude, 10);
}

async function findNearestAddress(latitude, longitude) {
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(latitude),
    lon: String(longitude),
    zoom: "18",
    addressdetails: "1",
    namedetails: "1"
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`);
  if (!response.ok) throw new Error("Reverse geocoding failed");
  return response.json();
}

function initializeCurrentLocation() {
  if (!locationStatus) return;

  if (!("geolocation" in navigator)) {
    setLocationStatus("現在地を取得できません");
    return;
  }

  setLocationStatus("現在地を確認中");

  navigator.geolocation.getCurrentPosition(async (position) => {
    const { latitude, longitude, accuracy } = position.coords;
    const accuracyText = Number.isFinite(accuracy)
      ? ` / 誤差約${Math.round(accuracy)}m`
      : "";
    const coordinateText = `現在地: ${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}${accuracyText}`;

    setLocationStatus(`${coordinateText} / 所在地と最寄りの寺を確認中`);

    try {
      const [nearestBuilding, nearestTemples] = await Promise.allSettled([
        findNearestOsmElement(latitude, longitude),
        findNearestTemples(latitude, longitude)
      ]);
      let nearestAddress = nearestBuilding.status === "fulfilled" ? nearestBuilding.value : "";
      if (!nearestAddress) {
        const nearestPlace = await findNearestAddress(latitude, longitude);
        nearestAddress = formatNearestAddress(nearestPlace);
      }
      const templeTop10 = nearestTemples.status === "fulfilled" ? nearestTemples.value : [];
      const detailNodes = [createTextNode(coordinateText)];
      if (nearestAddress) detailNodes.push(createTextNode(` / 所在地: ${nearestAddress}`));
      detailNodes.push(createTextNode(" / "), createNearestTemplePopup(templeTop10));
      replaceLocationStatus(...detailNodes);
    } catch (error) {
      console.error(error);
      setLocationStatus(`${coordinateText} / 所在地を取得できません`);
    }
  }, () => {
    setLocationStatus("現在地は未許可");
  }, {
    enableHighAccuracy: false,
    maximumAge: 1000 * 60 * 10,
    timeout: 10000
  });
}

function initializeCloudSync() {
  if (!hasFirebaseConfig()) {
    setSyncStatus("ローカル保存");
    setRegisteredCount(1);
    return;
  }

  if (cloudSyncStarted) return;

  if (!window.terawalkFirebaseSdk) {
    setSyncStatus("Firebase SDK読込中");
    window.addEventListener("terawalk-firebase-sdk-ready", initializeCloudSync, { once: true });
    return;
  }

  try {
    cloudSyncStarted = true;
    const sdk = window.terawalkFirebaseSdk;
    const app = sdk.initializeApp(window.terawalkFirebaseConfig);
    const db = sdk.getFirestore(app);
    recordsCollection = sdk.collection(db, "templeRecords");
    usersCollection = sdk.collection(db, "appUsers");
    cloudSyncEnabled = true;
    setSyncStatus("Firebaseに接続中");
    setRegisteredCount(1);

    sdk.setDoc(sdk.doc(usersCollection, getCurrentUserId()), {
      lastSeenAt: new Date().toISOString()
    }).catch((error) => {
      console.error(error);
      setRegisteredCount(1);
    });

    sdk.onSnapshot(usersCollection, (snapshot) => {
      setRegisteredCount(snapshot.size);
    }, (error) => {
      console.error(error);
      setRegisteredCount(1);
    });

    const localRecords = loadRecords();
    let migratedLocalRecords = false;

    sdk.onSnapshot(recordsCollection, async (snapshot) => {
      if (snapshot.empty && localRecords.length > 0 && !migratedLocalRecords) {
        migratedLocalRecords = true;
        await Promise.all(localRecords.map((record) => saveRecordToCloud(record)));
        return;
      }

      records = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      saveLocalRecords();
      renderRecords();
      setSyncStatus("Firebase同期中");
    }, (error) => {
      console.error(error);
      cloudSyncEnabled = false;
      setSyncStatus("ローカル保存");
      renderRecords();
    });
  } catch (error) {
    console.error(error);
    cloudSyncEnabled = false;
    setSyncStatus("ローカル保存");
  }
}

async function saveRecordToCloud(record) {
  if (!cloudSyncEnabled || !recordsCollection) return;
  const sdk = window.terawalkFirebaseSdk;
  await sdk.setDoc(sdk.doc(recordsCollection, record.id), record);
}

async function deleteRecordFromCloud(id) {
  if (!cloudSyncEnabled || !recordsCollection) return;
  const sdk = window.terawalkFirebaseSdk;
  await sdk.deleteDoc(sdk.doc(recordsCollection, id));
}

async function persistRecord(record) {
  saveLocalRecords();
  if (cloudSyncEnabled) {
    await saveRecordToCloud(record);
  }
}

async function removePersistedRecord(id) {
  saveLocalRecords();
  if (cloudSyncEnabled) {
    await deleteRecordFromCloud(id);
  }
}

function formatDate(value) {
  if (!value) return "日付未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date(`${value}T00:00:00`));
}

function resetForm() {
  form.reset();
  recordId.value = "";
  formTitle.textContent = "新しい記録";
  fields.name.focus();
}

function getFilteredRecords() {
  const query = searchInput.value.trim().toLowerCase();
  const filter = filterSelect.value;
  const sorted = [...records];

  sorted.sort((a, b) => {
    if (sortSelect.value === "name") {
      return a.name.localeCompare(b.name, "ja");
    }

    const first = a.visitedAt || "0000-00-00";
    const second = b.visitedAt || "0000-00-00";
    return sortSelect.value === "oldest"
      ? first.localeCompare(second)
      : second.localeCompare(first);
  });

  return sorted.filter((record) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "goshuin" && record.hasGoshuin) ||
      (filter === "favorite" && record.isFavorite);

    const searchable = `${record.name} ${record.area} ${record.notes}`.toLowerCase();
    return matchesFilter && searchable.includes(query);
  });
}

function updateStats() {
  document.querySelector("#totalCount").textContent = records.length;
  document.querySelector("#goshuinCount").textContent = records.filter((record) => record.hasGoshuin).length;
  document.querySelector("#favoriteCount").textContent = records.filter((record) => record.isFavorite).length;
}

function renderRecords() {
  const visibleRecords = getFilteredRecords();
  recordsList.innerHTML = "";
  emptyState.hidden = visibleRecords.length > 0;

  visibleRecords.forEach((record) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const media = node.querySelector(".record-media");
    const title = node.querySelector("h3");
    const meta = node.querySelector(".meta");
    const notes = node.querySelector(".notes");
    const badges = node.querySelector(".badges");
    const favoriteButton = node.querySelector(".favorite-button");

    title.textContent = record.name;
    meta.textContent = `${record.area || "地域未設定"} ・ ${formatDate(record.visitedAt)}`;
    notes.textContent = record.notes || "メモはまだありません。";
    favoriteButton.textContent = record.isFavorite ? "★" : "☆";

    if (record.photoUrl) {
      media.style.backgroundImage = `linear-gradient(rgba(31, 37, 35, 0.1), rgba(31, 37, 35, 0.28)), url("${record.photoUrl}")`;
    }

    if (record.hasGoshuin) badges.append(createBadge("御朱印", "gold"));
    if (record.isFavorite) badges.append(createBadge("お気に入り", "red"));
    if (!record.hasGoshuin && !record.isFavorite) badges.append(createBadge("参拝記録"));

    favoriteButton.addEventListener("click", async () => {
      const updatedRecord = { ...record, isFavorite: !record.isFavorite, updatedAt: new Date().toISOString() };
      records = records.map((item) =>
        item.id === record.id ? updatedRecord : item
      );
      await persistRecord(updatedRecord);
      updateStats();
      renderRecords();
    });

    node.querySelector(".edit-button").addEventListener("click", () => editRecord(record));
    node.querySelector(".delete-button").addEventListener("click", () => deleteRecord(record.id));
    recordsList.append(node);
  });

  updateStats();
}

function createBadge(text, tone = "") {
  const badge = document.createElement("span");
  badge.className = `badge ${tone}`.trim();
  badge.textContent = text;
  return badge;
}

function editRecord(record) {
  recordId.value = record.id;
  fields.name.value = record.name;
  fields.area.value = record.area;
  fields.visitedAt.value = record.visitedAt;
  fields.notes.value = record.notes;
  fields.photoUrl.value = record.photoUrl;
  fields.hasGoshuin.checked = record.hasGoshuin;
  fields.isFavorite.checked = record.isFavorite;
  formTitle.textContent = "記録を編集";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteRecord(id) {
  const target = records.find((record) => record.id === id);
  if (!target || !confirm(`${target.name} の記録を削除しますか？`)) return;
  records = records.filter((record) => record.id !== id);
  await removePersistedRecord(id);
  renderRecords();
  resetForm();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const nextRecord = {
    id: recordId.value || crypto.randomUUID(),
    name: fields.name.value.trim(),
    area: fields.area.value.trim(),
    visitedAt: fields.visitedAt.value,
    notes: fields.notes.value.trim(),
    photoUrl: fields.photoUrl.value.trim(),
    hasGoshuin: fields.hasGoshuin.checked,
    isFavorite: fields.isFavorite.checked,
    updatedAt: new Date().toISOString()
  };

  if (recordId.value) {
    records = records.map((record) => record.id === recordId.value ? nextRecord : record);
  } else {
    records = [nextRecord, ...records];
  }

  await persistRecord(nextRecord);
  renderRecords();
  resetForm();
});

resetButton.addEventListener("click", resetForm);
fields.name.addEventListener("input", () => updateTempleSuggestions(fields.name.value));
fields.name.addEventListener("change", fillTempleLocation);
searchInput.addEventListener("input", renderRecords);
filterSelect.addEventListener("change", renderRecords);
sortSelect.addEventListener("change", renderRecords);

setupTempleDatabase();
renderRecords();
initializeCurrentLocation();
initializeCloudSync();
