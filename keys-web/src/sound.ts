/**
 * Tiny Web Audio synth for interface sounds. Each sound is a list of partials (oscillator or
 * filtered noise) with a quick attack and an exponential decay. Nothing plays until the page
 * has had a trusted user gesture, as browsers require.
 */
type Tone = {
  hz: number;
  to?: number;
  glide?: number;
  ms: number;
  gain?: number;
  wave?: OscillatorType;
  cut?: number;
  atk?: number;
  at?: number;
};

const SOUNDS = {
  /* a right code */
  perk: [{ hz: 330, ms: 360, gain: 0.053, wave: 'sine', cut: 560, atk: 90 }],
  /* a wrong one */
  deny: [{ hz: 208, to: 165, ms: 120, gain: 0.03, wave: 'sine', cut: 520, atk: 10 }],
  /* the capsule splitting back into cells */
  expand: [
    { hz: 196, to: 174, ms: 360, gain: 0.042, wave: 'sine', cut: 880, atk: 36 },
    { hz: 294, to: 262, ms: 300, gain: 0.014, wave: 'sine', cut: 1100, atk: 48, at: 24 },
  ],
  /* a toggle turning on, turning off, and being dragged */
  click: [{ hz: 196, to: 130, ms: 150, gain: 0.07, wave: 'sine', cut: 900 }],
  off: [{ hz: 330, to: 247, ms: 88, gain: 0.03, wave: 'sine', cut: 720, atk: 8 }],
  drag: [{ hz: 174, to: 155, ms: 250, gain: 0.034, wave: 'sine', cut: 640, atk: 28 }],
} satisfies Record<string, Tone[]>;

export type SoundName = keyof typeof SOUNDS;

let ctx: AudioContext | null = null;
let gestured = false;
let primed = false;

function wakeAudio() {
  try {
    ctx ??= new AudioContext();
  } catch {
    return;
  }
  if (ctx.state !== 'running') void ctx.resume();
  if (!primed) {
    primed = true;
    try {
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);
    } catch {
      /* ignore */
    }
  }
}

if (typeof window !== 'undefined') {
  const events = ['pointerdown', 'keydown', 'touchend', 'click'];
  const unlock = (e: Event) => {
    if (!e.isTrusted) return;
    gestured = true;
    wakeAudio();
    if (ctx?.state === 'running') for (const t of events) window.removeEventListener(t, unlock, true);
  };
  for (const t of events) window.addEventListener(t, unlock, true);
}

const lastAt: Partial<Record<SoundName, number>> = {};

/** `at` (0–1) shifts the pitch from 0.75× to 1.5×; `gap` (ms) skips repeats closer than that. */
export function play(name: SoundName, opts?: { at?: number; gap?: number }) {
  if (!gestured) return;
  if (opts?.gap) {
    const t = performance.now();
    if (t - (lastAt[name] ?? -Infinity) < opts.gap) return;
    lastAt[name] = t;
  }
  const pitch = opts?.at === undefined ? 1 : 0.75 + Math.min(1, Math.max(0, opts.at)) * 0.75;
  wakeAudio();
  const ac = ctx;
  if (!ac || ac.state !== 'running') return;
  const now = ac.currentTime;
  for (const p of SOUNDS[name] as Tone[]) {
    const t0 = now + (p.at ?? 0) / 1000;
    const end = t0 + p.ms / 1000;
    const glideEnd = p.glide ? t0 + p.glide / 1000 : end;
    const osc = ac.createOscillator();
    osc.type = p.wave ?? 'sine';
    osc.frequency.setValueAtTime(p.hz * pitch, t0);
    if (p.to) osc.frequency.exponentialRampToValueAtTime(p.to * pitch, glideEnd);
    const g = ac.createGain();
    const atk = Math.min((p.atk ?? 4) / 1000, (p.ms / 1000) * 0.6);
    g.gain.setValueAtTime(1e-4, t0);
    g.gain.exponentialRampToValueAtTime(p.gain ?? 0.05, t0 + atk);
    g.gain.exponentialRampToValueAtTime(1e-4, end);
    let out: AudioNode = osc;
    if (p.cut) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = p.cut;
      osc.connect(f);
      out = f;
    }
    out.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(end + 0.02);
  }
}
