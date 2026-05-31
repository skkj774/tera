const storageKey = "tera.templeRecords";

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

function setLocationStatus(text) {
  if (locationStatus) locationStatus.textContent = text;
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

    setLocationStatus(`${coordinateText} / 所在地を確認中`);

    try {
      const nearestPlace = await findNearestAddress(latitude, longitude);
      const nearestAddress = formatNearestAddress(nearestPlace);
      setLocationStatus(nearestAddress ? `${coordinateText} / 所在地: ${nearestAddress}` : coordinateText);
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
    cloudSyncEnabled = true;
    setSyncStatus("Firebaseに接続中");

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
