// Synthesized sound, no samples. A mains hum (120 Hz ballast buzz and its harmonics) whose loudness
// follows the working panels around you, a harsher crackle that switches on and off with flickering
// panels, and a faint room tone that stays when the lights are gone.
// update() runs every frame and allocates nothing.
import { CELL, lightLevel } from './gen.js';
import { cellLight, levelSeed } from './levels.js';

export function createAudio() {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let vol = 0.5, muted = false;
  const level = () => muted ? 0 : vol * vol;           // squared: the slider feels even
  const master = ac.createGain(); master.gain.value = level(); master.connect(ac.destination);

  // white noise buffer, shared by the room tone and the crackle
  const nb = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const noise = () => { const s = ac.createBufferSource(); s.buffer = nb; s.loop = true; s.start(); return s; };

  // hum: 60 Hz fundamental, strong 120/240, a little 360; slightly detuned pairs make it beat slowly
  const hum = ac.createGain(); hum.gain.value = 0; hum.connect(master);
  const humLP = ac.createBiquadFilter(); humLP.type = 'lowpass'; humLP.frequency.value = 900; humLP.connect(hum);
  for (const [f, g, type] of [[60, 0.25, 'sine'], [120, 0.5, 'sawtooth'], [120.4, 0.25, 'sine'], [240, 0.18, 'sine'], [360.3, 0.06, 'sine']]) {
    const o = ac.createOscillator(); o.type = type; o.frequency.value = f;
    const og = ac.createGain(); og.gain.value = g; o.connect(og).connect(humLP); o.start();
  }
  // a thin high whine on top of the hum
  const whine = ac.createOscillator(); whine.frequency.value = 7820;
  const wg = ac.createGain(); wg.gain.value = 0.0015; whine.connect(wg).connect(hum); whine.start();

  // crackle: buzzing arc of a failing starter, gated by the flicker state
  const crackle = ac.createGain(); crackle.gain.value = 0; crackle.connect(master);
  const cbp = ac.createBiquadFilter(); cbp.type = 'bandpass'; cbp.frequency.value = 2400; cbp.Q.value = 0.7; cbp.connect(crackle);
  noise().connect(cbp);
  const zap = ac.createOscillator(); zap.type = 'square'; zap.frequency.value = 120;
  const zg = ac.createGain(); zg.gain.value = 0.25; zap.connect(zg).connect(cbp); zap.start();

  // room tone: very quiet low rumble, always there
  const room = ac.createGain(); room.gain.value = 0.035; room.connect(master);
  const rlp = ac.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 160; rlp.connect(room);
  noise().connect(rlp);

  return {
    resume() { if (ac.state !== 'running') ac.resume(); },
    toggleMute() { muted = !muted; master.gain.setTargetAtTime(level(), ac.currentTime, 0.05); return muted; },
    setVolume(v) { vol = v; master.gain.setTargetAtTime(level(), ac.currentTime, 0.05); },
    // listener at (x, z) metres, t = the same clock the shader flickers by
    update(seed, lv, x, z, t) {
      const sL = levelSeed(seed, lv);
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      let steady = 0, flick = 0;
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const X = cx + dx, Z = cz + dz, k = cellLight(seed, lv, X, Z);
        if (k === 0) continue;
        const lx = (X + 0.5) * CELL - x, lz = (Z + 0.5) * CELL - z;
        const w = 1 / (1 + (lx * lx + lz * lz) / 6);
        const lvl = lightLevel(sL, X, Z, k, t);
        steady += w * lvl;
        if (k === 2 || k === 4) {
          // a flickering panel crackles while it is stuttering (its level jumps between frames)
          const prev = lightLevel(sL, X, Z, k, t - 0.045);
          if (Math.abs(prev - lvl) > 0.3 || lvl < 0.1) flick += w;
        }
      }
      const now = ac.currentTime;
      hum.gain.setTargetAtTime(Math.min(0.06, steady * 0.022), now, 0.08);
      crackle.gain.setTargetAtTime(Math.min(0.05, flick * 0.04), now, 0.012);
    },
  };
}
