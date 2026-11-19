// Synthesized sound, no samples. A mains hum (120 Hz ballast buzz and its harmonics) whose loudness
// follows the working panels around you, a harsher crackle that switches on and off with flickering
// panels, and a faint room tone that stays when the lights are gone.
// On top of that: your own footsteps, the hum dropping in pitch in odd rooms, pockets of total
// silence, and now and then a single sound somewhere out of sight (a door, footsteps that keep pace
// with yours, a chair dragged, a phone far off), with long quiet stretches in between.
// update() runs every frame and allocates nothing except when one of those sounds starts.
import { CELL, lightLevel, roomCell, mutation, hashU } from './gen.js';
import { liveLight, levelSeed } from './levels.js';

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
  const humOsc = [];
  for (const [f, g, type] of [[60, 0.25, 'sine'], [120, 0.5, 'sawtooth'], [120.4, 0.25, 'sine'], [240, 0.18, 'sine'], [360.3, 0.06, 'sine']]) {
    const o = ac.createOscillator(); o.type = type; o.frequency.value = f; humOsc.push([o, f]);
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
  const roomG = ac.createGain(); roomG.gain.value = 0.035; roomG.connect(master);
  const rlp = ac.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 160; rlp.connect(roomG);
  let curPitch = 1;
  noise().connect(rlp);

  // drone rotors: a thin buzz with a whir of noise, pitched up by speed; silent while walking
  const rotor = ac.createGain(); rotor.gain.value = 0; rotor.connect(master);
  const rlp2 = ac.createBiquadFilter(); rlp2.type = 'lowpass'; rlp2.frequency.value = 1800; rlp2.connect(rotor);
  const rotors = [];
  for (const [f, g] of [[182, 0.22], [188.5, 0.18], [364, 0.07]]) {
    const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const og = ac.createGain(); og.gain.value = g; o.connect(og).connect(rlp2); o.start(); rotors.push([o, f]);
  }
  const whir = ac.createBiquadFilter(); whir.type = 'bandpass'; whir.frequency.value = 900; whir.Q.value = 1.2;
  const wg2 = ac.createGain(); wg2.gain.value = 0.5; noise().connect(whir).connect(wg2).connect(rotor);

  // camera shutter: a short click and a softer second one
  function shutter() {
    const t0 = ac.currentTime;
    for (const [dt, g] of [[0, 0.5], [0.07, 0.3]]) {
      const s = ac.createBufferSource(); s.buffer = nb;
      const bp = ac.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = 2500;
      const sg = ac.createGain(); sg.gain.setValueAtTime(g, t0 + dt); sg.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.035);
      s.connect(bp).connect(sg).connect(master); s.start(t0 + dt, Math.random()); s.stop(t0 + dt + 0.05);
    }
  }

  // ---- one-off sounds: a bus with a long synthetic reverb, placed in 3D around the listener ----
  const L = ac.listener;
  const verb = ac.createConvolver();
  { const n = Math.floor(ac.sampleRate * 2.4), ir = ac.createBuffer(2, n, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2); }
    verb.buffer = ir; }
  const verbG = ac.createGain(); verbG.gain.value = 0.55; verb.connect(verbG).connect(master);
  const bus = ac.createGain(); bus.gain.value = 1; bus.connect(master); bus.connect(verb);
  let lx = 0, lz = 0, lyaw = 0;
  // a source chain ending in a panner at (x, z) metres, muffled more the further away
  function place(x, z, y = 1.2) {
    const p = ac.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 2; p.rolloffFactor = 1;
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = 9000 / (1 + Math.hypot(x - lx, z - lz) / 6);
    lp.connect(p).connect(bus);
    return lp;
  }
  const burst = (t0, dest, dur, type, f, q, g) => {    // filtered noise with a fast decay
    const s = ac.createBufferSource(); s.buffer = nb;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const e = ac.createGain(); e.gain.setValueAtTime(g, t0); e.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    s.connect(fl).connect(e).connect(dest); s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.02);
  };
  const tone = (t0, dest, f0, f1, dur, g, type = 'sine') => {
    const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const e = ac.createGain(); e.gain.setValueAtTime(g, t0); e.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    o.connect(e).connect(dest); o.start(t0); o.stop(t0 + dur + 0.02);
  };
  // a footfall on carpet (0), soaked carpet (1) or tile (2)
  const footfall = (t0, dest, surf, g) => {
    burst(t0, dest, 0.09, 'lowpass', 320, 0.7, 0.5 * g); tone(t0, dest, 85, 45, 0.1, 0.35 * g);
    if (surf === 1) burst(t0 + 0.03, dest, 0.12, 'bandpass', 900 + Math.random() * 400, 2.5, 0.22 * g);
    if (surf === 2) burst(t0, dest, 0.03, 'highpass', 2500, 0.7, 0.3 * g);
  };
  const EVENTS = {
    door(t0, d) { burst(t0, d, 0.02, 'highpass', 1800, 0.8, 0.5); burst(t0 + 0.09, d, 0.03, 'bandpass', 1200, 3, 0.5); tone(t0 + 0.09, d, 110, 60, 0.18, 0.5); },
    slam(t0, d) { burst(t0, d, 0.5, 'lowpass', 400, 0.8, 1.0); tone(t0, d, 70, 35, 0.6, 0.9); burst(t0 + 0.02, d, 0.05, 'bandpass', 1500, 2, 0.3); },
    scrape(t0, d) {
      const dur = 0.6 + Math.random() * 0.7, s = ac.createBufferSource(); s.buffer = nb;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6; bp.frequency.setValueAtTime(500, t0); bp.frequency.linearRampToValueAtTime(950, t0 + dur);
      const e = ac.createGain(); e.gain.setValueAtTime(0, t0);
      for (let k = 0; k < 12; k++) e.gain.linearRampToValueAtTime((0.3 + 0.5 * Math.random()) * 1.2, t0 + dur * (k + 0.5) / 12);
      e.gain.linearRampToValueAtTime(0, t0 + dur);
      s.connect(bp).connect(e).connect(d); s.start(t0); s.stop(t0 + dur + 0.05);
    },
    phone(t0, d) {                                  // two-tone ring, 2 s on, 4 s off
      const n = 2 + Math.floor(Math.random() * 3), bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.8;
      const e = ac.createGain(); e.gain.value = 0; bp.connect(e).connect(d);
      for (const f of [440, 480]) { const o = ac.createOscillator(); o.frequency.value = f; o.connect(bp); o.start(t0); o.stop(t0 + n * 6); }
      const am = ac.createOscillator(); am.frequency.value = 20; const amg = ac.createGain(); amg.gain.value = 0.12; am.connect(amg).connect(e.gain); am.start(t0); am.stop(t0 + n * 6);
      for (let k = 0; k < n; k++) { e.gain.setValueAtTime(0.14, t0 + k * 6); e.gain.setValueAtTime(0, t0 + k * 6 + 2); }
    },
    drip(t0, d) { for (let k = 0; k < 3 + Math.random() * 4; k++) tone(t0 + k * (0.7 + Math.random()), d, 1900 + Math.random() * 500, 700, 0.06, 0.25); },
    walk(t0, d) { const n = 4 + Math.floor(Math.random() * 6), gap = 0.5 + Math.random() * 0.15; for (let k = 0; k < n; k++) footfall(t0 + k * gap, d, 0, 0.9); },
  };
  let nextAt = 0, follow = 0, lastStep = 0, followOwed = false, lastSurf = 0;
  const firstGap = () => 20 + Math.random() * 25;

  return {
    shutter,
    // your footstep, on surface 0 carpet / 1 wet / 2 tile; loud 0..1. A follower, when one is about,
    // takes a step a moment after you, somewhere behind.
    step(surf, loud) {
      const t0 = ac.currentTime;
      footfall(t0, master, surf, 0.05 + 0.08 * loud);
      lastStep = t0; lastSurf = surf;
      if (t0 < follow) {
        const b = 7 + Math.random() * 2, a = lyaw + Math.PI + (Math.random() - 0.5) * 0.4;
        footfall(t0 + 0.22, place(lx + Math.sin(a) * b, lz - Math.cos(a) * b, 0.1), surf, 0.5);
        followOwed = true;
      }
    },
    // where you are and which way you face (yaw 0 = -z)
    listen(x, y, z, yaw) {
      lx = x; lz = z; lyaw = yaw;
      if (L.positionX) { L.positionX.value = x; L.positionY.value = y; L.positionZ.value = z; L.forwardX.value = Math.sin(yaw); L.forwardY.value = 0; L.forwardZ.value = -Math.cos(yaw); L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
      else { L.setPosition(x, y, z); L.setOrientation(Math.sin(yaw), 0, -Math.cos(yaw), 0, 1, 0); }
    },
    // speed in m/s, or -1 when not flying
    drone(speed) {
      const now = ac.currentTime, on = speed >= 0, k = 1 + Math.min(1, Math.max(0, speed) / 7) * 0.35;
      rotor.gain.setTargetAtTime(on ? 0.05 : 0, now, on ? 0.15 : 0.3);
      for (const [o, f] of rotors) o.frequency.setTargetAtTime(f * k, now, 0.2);
    },
    resume() { if (ac.state !== 'running') ac.resume(); },
    toggleMute() { muted = !muted; master.gain.setTargetAtTime(level(), ac.currentTime, 0.05); return muted; },
    setVolume(v) { vol = v; master.gain.setTargetAtTime(level(), ac.currentTime, 0.05); },
    // listener at (x, z) metres, t = the same clock the shader flickers by
    update(seed, lv, x, z, t) {
      const sL = levelSeed(seed, lv);
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      const now0 = ac.currentTime, room = roomCell(sL, cx, cz), mu = mutation(lv, cx, cz) / 8;
      // pockets of dead silence: hum, crackle and room tone all gone (more of them further out)
      const silent = hashU(sL, 990, Math.floor(cx / 5), Math.floor(cz / 5)) / 4294967296 < 0.03 + 0.05 * mu;
      // the hum sags in odd rooms
      const pitch = room === 6 ? 0.93 : room === 4 || room === 11 ? 0.96 : room === 10 ? 0.985 : 1;
      if (pitch !== curPitch) { curPitch = pitch; for (const [o, f] of humOsc) o.frequency.setTargetAtTime(f * pitch, now0, 0.6); }
      roomG.gain.setTargetAtTime(silent ? 0 : 0.035, now0, 0.25);
      // the one-off sounds
      if (!nextAt) nextAt = now0 + firstGap();
      if (now0 >= nextAt) {
        const r = Math.random(), wet = room === 7 || room === 9;
        const kind = wet && r < 0.35 ? 'drip' : r < 0.22 ? 'door' : r < 0.42 ? 'follow' : r < 0.58 ? 'scrape' : r < 0.7 ? 'phone' : r < 0.82 ? 'walk' : r < 0.9 ? 'slam' : 'drip';
        if (kind === 'follow') { follow = now0 + 12 + Math.random() * 10; }
        else {
          const a = lyaw + Math.PI + (Math.random() - 0.5) * 2.4, dist = kind === 'phone' || kind === 'slam' ? 25 + Math.random() * 20 : 9 + Math.random() * 12;
          EVENTS[kind](now0 + 0.05, place(lx + Math.sin(a) * dist, lz - Math.cos(a) * dist, kind === 'walk' ? 0.1 : 1.2));
        }
        nextAt = now0 + (30 + Math.random() * 60) * (1 - 0.5 * mu);
      }
      // the follower: when you stop, it takes one more step, then nothing
      if (followOwed && now0 - lastStep > 0.75) {
        followOwed = false;
        const a = lyaw + Math.PI, b = 7.5;
        footfall(now0, place(lx + Math.sin(a) * b, lz - Math.cos(a) * b, 0.1), lastSurf, 0.55);
      }
      let steady = 0, flick = 0;
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const X = cx + dx, Z = cz + dz, k = liveLight(seed, lv, X, Z, cx, cz);
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
      hum.gain.setTargetAtTime(silent ? 0 : Math.min(0.06, steady * 0.022), now, silent ? 0.25 : 0.08);
      crackle.gain.setTargetAtTime(silent ? 0 : Math.min(0.05, flick * 0.04), now, 0.012);
    },
  };
}
