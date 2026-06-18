'use strict';

const STORAGE_KEY = 'playlist2mp3_settings';

let currentTracks = [];
let stopRequested = false;
let isDownloading = false;

// ---------- Configuración (localStorage) ----------

function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSettingsToStorage(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function loadSettingsIntoForm() {
  const s = getSettings();
  document.getElementById('youtubeApiKey').value = s.youtubeApiKey || '';
  document.getElementById('cobaltUrl').value = s.cobaltUrl || '';
  document.getElementById('cobaltApiKey').value = s.cobaltApiKey || '';
  document.getElementById('numberFiles').checked = s.numberFiles !== false;
}

function readSettingsFromForm() {
  return {
    youtubeApiKey: document.getElementById('youtubeApiKey').value.trim(),
    cobaltUrl: document.getElementById('cobaltUrl').value.trim().replace(/\/+$/, ''),
    cobaltApiKey: document.getElementById('cobaltApiKey').value.trim(),
    numberFiles: document.getElementById('numberFiles').checked
  };
}

// ---------- Utilidades ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'audio';
}

function extractPlaylistId(input) {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const listParam = url.searchParams.get('list');
    if (listParam) return listParam;
  } catch (e) {
    // no era una URL completa, puede que sea el ID directamente
  }
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- YouTube Data API ----------

async function fetchPlaylistItems(apiKey, playlistId, onProgress) {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      part: 'snippet',
      maxResults: '50',
      playlistId,
      key: apiKey
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`);
    const data = await res.json();

    if (data.error) {
      throw new Error(data.error.message || 'Error de la API de YouTube');
    }

    for (const item of (data.items || [])) {
      const title = item.snippet && item.snippet.title;
      const videoId = item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId;
      if (!videoId || title === 'Deleted video' || title === 'Private video') continue;
      items.push({ videoId, title });
    }

    pageToken = data.nextPageToken;
    if (onProgress) onProgress(items.length);
  } while (pageToken);

  return items;
}

// ---------- Cobalt ----------

async function resolveDownloadUrl(cobaltUrl, cobaltApiKey, videoUrl) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  if (cobaltApiKey) headers['Authorization'] = `Api-Key ${cobaltApiKey}`;

  const res = await fetch(`${cobaltUrl}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: videoUrl,
      downloadMode: 'audio',
      audioFormat: 'mp3',
      alwaysProxy: true,
      filenameStyle: 'basic'
    })
  });

  if (!res.ok) {
    throw new Error(`Cobalt respondió con estado HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.status === 'error') {
    throw new Error((data.error && data.error.code) || 'Error desconocido de Cobalt');
  }
  if (data.status === 'tunnel' || data.status === 'redirect') {
    return data.url;
  }
  if (data.status === 'picker' && data.audio) {
    return data.audio;
  }
  throw new Error(`Respuesta inesperada de Cobalt: ${data.status}`);
}

async function downloadBlob(streamUrl) {
  const res = await fetch(streamUrl);
  if (!res.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${res.status})`);
  return await res.blob();
}

async function writeFileToDirectory(dirHandle, filename, blob) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

// ---------- UI: lista de pistas ----------

function renderTrackList(tracks) {
  const list = document.getElementById('trackList');
  list.innerHTML = '';
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'track';
    li.dataset.index = String(i);
    li.innerHTML = `
      <input type="checkbox" class="track__checkbox" checked>
      <span class="track__title">${escapeHtml(t.title)}</span>
      <span class="track__status" data-status="pending">pendiente</span>
    `;
    list.appendChild(li);
  });
  document.getElementById('trackCount').textContent =
    `${tracks.length} vídeo${tracks.length === 1 ? '' : 's'}`;
  document.getElementById('trackListSection').classList.remove('hidden');
}

function getSelectedIndices() {
  const checkboxes = document.querySelectorAll('.track__checkbox');
  const indices = [];
  checkboxes.forEach((cb, i) => { if (cb.checked) indices.push(i); });
  return indices;
}

function setTrackStatus(index, status, label) {
  const row = document.querySelector(`.track[data-index="${index}"] .track__status`);
  if (!row) return;
  row.dataset.status = status;
  row.textContent = label;
}

function updateProgress(done, total) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  document.getElementById('progressFill').style.width = `${pct}%`;
  document.getElementById('progressLabel').textContent = `${done} / ${total} completados`;
}

function toggleDownloadingUI(downloading) {
  isDownloading = downloading;
  document.getElementById('chooseFolderBtn').classList.toggle('hidden', downloading);
  document.getElementById('stopBtn').classList.toggle('hidden', !downloading);
  document.getElementById('progressWrap').classList.toggle('hidden', !downloading);
  document.getElementById('loadPlaylist').disabled = downloading;
}

// ---------- Flujo principal ----------

async function handleLoadPlaylist() {
  const settings = readSettingsFromForm();
  const statusEl = document.getElementById('playlistStatus');

  if (!settings.youtubeApiKey) {
    statusEl.textContent = 'Falta la clave de la API de YouTube. Ábrela en Configuración.';
    statusEl.className = 'status status--err';
    return;
  }

  const playlistUrl = document.getElementById('playlistUrl').value;
  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) {
    statusEl.textContent = 'No reconozco esa URL de playlist. Revisa que incluya "list=…".';
    statusEl.className = 'status status--err';
    return;
  }

  statusEl.textContent = 'Cargando vídeos…';
  statusEl.className = 'status';
  document.getElementById('loadPlaylist').disabled = true;

  try {
    const tracks = await fetchPlaylistItems(settings.youtubeApiKey, playlistId, (count) => {
      statusEl.textContent = `Cargando vídeos… (${count} encontrados hasta ahora)`;
    });
    currentTracks = tracks;
    renderTrackList(tracks);
    statusEl.textContent = `${tracks.length} vídeos cargados.`;
    statusEl.className = 'status status--ok';
  } catch (err) {
    statusEl.textContent = `Error al cargar la playlist: ${err.message}`;
    statusEl.className = 'status status--err';
  } finally {
    document.getElementById('loadPlaylist').disabled = false;
  }
}

async function handleChooseFolderAndDownload() {
  const settings = readSettingsFromForm();

  if (!settings.cobaltUrl) {
    alert('Configura primero la URL de tu backend de Cobalt en Configuración.');
    return;
  }
  if (!window.showDirectoryPicker) {
    alert('Tu navegador no soporta elegir carpetas. Usa Chrome o Edge de escritorio.');
    return;
  }

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker();
  } catch (e) {
    return; // el usuario canceló el selector
  }

  const selected = getSelectedIndices();
  if (selected.length === 0) {
    alert('No hay ningún vídeo seleccionado.');
    return;
  }

  stopRequested = false;
  toggleDownloadingUI(true);

  let done = 0;
  const total = selected.length;
  updateProgress(0, total);

  for (const i of selected) {
    if (stopRequested) break;
    const track = currentTracks[i];
    setTrackStatus(i, 'downloading', 'descargando…');

    try {
      const videoUrl = `https://www.youtube.com/watch?v=${track.videoId}`;
      const streamUrl = await resolveDownloadUrl(settings.cobaltUrl, settings.cobaltApiKey, videoUrl);
      const blob = await downloadBlob(streamUrl);
      const prefix = settings.numberFiles ? `${String(i + 1).padStart(2, '0')} - ` : '';
      const filename = `${prefix}${sanitizeFilename(track.title)}.mp3`;
      await writeFileToDirectory(dirHandle, filename, blob);
      setTrackStatus(i, 'done', '✓ listo');
    } catch (err) {
      console.error(track.title, err);
      setTrackStatus(i, 'error', `✗ ${err.message}`);
    }

    done++;
    updateProgress(done, total);
    await sleep(300); // pequeña pausa de cortesía entre peticiones
  }

  toggleDownloadingUI(false);
}

// ---------- Inicialización ----------

function checkBrowserCompat() {
  if (!window.showDirectoryPicker) {
    document.getElementById('compatWarning').classList.remove('hidden');
    document.getElementById('chooseFolderBtn').disabled = true;
  }
}

function wireSettingsPanel() {
  const panel = document.getElementById('settingsPanel');
  document.getElementById('toggleSettings').addEventListener('click', () => {
    panel.classList.toggle('hidden');
  });
  document.getElementById('saveSettings').addEventListener('click', () => {
    saveSettingsToStorage(readSettingsFromForm());
    const saved = document.getElementById('settingsSaved');
    saved.classList.remove('hidden');
    setTimeout(() => saved.classList.add('hidden'), 1800);
  });
}

function wireTrackSelection() {
  document.getElementById('selectAll').addEventListener('click', () => {
    document.querySelectorAll('.track__checkbox').forEach(cb => cb.checked = true);
  });
  document.getElementById('selectNone').addEventListener('click', () => {
    document.querySelectorAll('.track__checkbox').forEach(cb => cb.checked = false);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettingsIntoForm();
  wireSettingsPanel();
  wireTrackSelection();
  checkBrowserCompat();

  document.getElementById('loadPlaylist').addEventListener('click', handleLoadPlaylist);
  document.getElementById('chooseFolderBtn').addEventListener('click', handleChooseFolderAndDownload);
  document.getElementById('stopBtn').addEventListener('click', () => { stopRequested = true; });
});
