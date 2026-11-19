// Photos: P takes one, O turns on an automatic camera (one every AUTO_EVERY seconds).
// Each photo is a JPEG of the canvas. They are kept in memory and saved from the menu as one .zip,
// or, once a folder is picked (Chrome/Edge), written straight into that folder as they are taken.
// Every photo's spot is written to where.txt as a link that opens the game there.
export const AUTO_EVERY = 2;

export function createPhotos(canvas, onChange) {
  const shots = [];             // { name, blob } kept until saved
  const where = [];             // "name  link" lines
  let dir = null, count = 0, pending = 0, folderName = '';

  async function writeFile(name, data) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(data); await w.close();
  }

  // call right after the frame is drawn, in the same task, while the canvas still holds it
  // stamp: null, or two lines (date, time) burned into the corner like a camcorder's
  let cv2 = null;
  function take(seed, view, drone, stamp) {
    const n = ++count, name = 'manila-' + seed + '-' + String(n).padStart(3, '0') + '.jpg';
    const link = location.href.split(/[?#]/)[0] + '?seed=' + seed + '&x=' + view.x.toFixed(2) + '&z=' + view.z.toFixed(2) +
      '&y=' + view.y.toFixed(2) + '&yaw=' + (view.yaw * 180 / Math.PI).toFixed(1) + '&pitch=' + (view.pitch * 180 / Math.PI).toFixed(1) + (drone ? '&drone' : '');
    where.push(name + '  ' + link);
    pending++;
    let srcCanvas = canvas;
    if (stamp) {                       // copy the frame into a 2D canvas and print the stamp on it
      cv2 = cv2 || document.createElement('canvas');
      cv2.width = canvas.width; cv2.height = canvas.height;
      const g = cv2.getContext('2d'), u = canvas.height / 720;
      g.drawImage(canvas, 0, 0);
      g.font = `bold ${Math.round(30 * u)}px "Courier New", monospace`; g.textBaseline = 'alphabetic';
      g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowOffsetX = g.shadowOffsetY = 2 * u; g.fillStyle = '#f4f1e0';
      g.fillText('PLAY \u25B6', 46 * u, 70 * u);
      g.textAlign = 'right';
      g.fillText(stamp[1], canvas.width - 46 * u, canvas.height - 84 * u);
      g.fillText(stamp[0], canvas.width - 46 * u, canvas.height - 46 * u);
      srcCanvas = cv2;
    }
    srcCanvas.toBlob(async (blob) => {
      pending--;
      if (!blob) { onChange(); return; }
      if (dir) {
        try { await writeFile(name, blob); await writeFile('where.txt', where.join('\n') + '\n'); }
        catch (e) { console.warn('could not write to the folder, keeping the photo', e); dir = null; shots.push({ name, blob }); }
      } else shots.push({ name, blob });
      onChange();
    }, 'image/jpeg', 0.92);
  }

  async function pickFolder() {
    if (!window.showDirectoryPicker) throw new Error('This browser cannot save to a folder. Use Save all instead.');
    dir = await window.showDirectoryPicker({ id: 'backrooms-photos', mode: 'readwrite' });
    folderName = dir.name;
    // anything already taken goes in too
    while (shots.length) { const s = shots.shift(); await writeFile(s.name, s.blob); }
    if (where.length) await writeFile('where.txt', where.join('\n') + '\n');
    onChange();
  }

  async function saveZip(seed) {
    if (!shots.length) return;
    const files = [];
    for (const s of shots) files.push({ name: s.name, data: new Uint8Array(await s.blob.arrayBuffer()) });
    files.push({ name: 'where.txt', data: new TextEncoder().encode(where.join('\n') + '\n') });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip(files));
    a.download = 'manila-' + seed + '-photos.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    shots.length = 0;
    onChange();
  }

  return {
    take, pickFolder, saveZip,
    get count() { return count; },
    get unsaved() { return shots.length + pending; },
    get folder() { return dir ? folderName : ''; },
  };
}

// ---- a plain .zip (stored, not compressed: JPEGs don't shrink anyway) ----
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
function crc32(d) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(files) {
  const parts = [], central = [], enc = new TextEncoder();
  let off = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    parts.push(h, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(c, name);
    off += 30 + name.length + size;
  }
  const csize = central.reduce((s, p) => s + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e], { type: 'application/zip' });
}
