'use strict';

const fs = require('fs');
const path = require('path');

/** Read a JSON snapshot. Returns null when there is none yet. */
function loadSnapshot(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // Keep the unreadable file for inspection instead of silently overwriting it.
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    console.error(`Could not read ${file} (${err.message}); moved it to ${aside} and starting fresh.`);
    return null;
  }
}

/**
 * Writes snapshots atomically (temp file + rename), so a crash mid-write
 * never leaves a truncated file behind. Writes are synchronous on purpose:
 * the state is small (a few hundred KB, ~1 ms to write) and this makes it
 * impossible for an older save to land after a newer one.
 *
 * - requestSave(): debounced save shortly after a change
 * - saveNow():     immediate save (shutdown)
 */
function createSaver(file, getState, { debounceMs = 1000, intervalMs = 15000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  let timer = null;

  function saveNow() {
    clearTimeout(timer);
    timer = null;
    try {
      fs.writeFileSync(tmp, JSON.stringify(getState()));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`Failed to save state to ${file}: ${err.message}`);
    }
  }

  function requestSave() {
    if (!timer) timer = setTimeout(saveNow, debounceMs);
  }

  // Market history changes constantly; save it on a slower heartbeat.
  const heartbeat = setInterval(requestSave, intervalMs);
  heartbeat.unref();

  function stop() {
    clearInterval(heartbeat);
    clearTimeout(timer);
    timer = null;
  }

  return { requestSave, saveNow, stop };
}

module.exports = { loadSnapshot, createSaver };
