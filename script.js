const cv = document.getElementById('c');
const cx = cv.getContext('2d');
cx.imageSmoothingEnabled = false;

// ── AUDIO ────────────────────────────────────────────────────────────
// Every sound is synthesized on the fly via WebAudio, not a loaded file —
// a racket hit is a bright, filtered burst of noise (the strings/ball
// "crack") layered with a fast pitch-dropping thump underneath (the body/
// weight of the contact). No music, just this one satisfying hit sound,
// per the brief.
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { console.warn('WebAudio unsupported in this browser — hit sound disabled.'); return null; }
    audioCtx = new Ctor();
  }
  return audioCtx;
}
// Browsers block audio until a real user gesture unlocks it. Called from
// inside the existing keydown/click/pointerdown handlers (see below) so
// resume() fires synchronously within an actual gesture. resume() is async
// and its promise can still be pending by the time the first hit sound
// wants to play, so playHitSound() below does NOT gate on ctx.state — it
// always schedules the sound and separately kicks resume() again, rather
// than silently giving up if the state hasn't flipped to 'running' yet.
function unlockAudio() {
  const ctx = getAudioCtx();
  if (ctx && ctx.state !== 'running') ctx.resume().catch(err => console.warn('Audio resume failed:', err));
}

function playNoiseBurst(ctx, when, duration, filterFreq, gainPeak) {
  const bufferSize = Math.max(1, Math.ceil(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;
  filter.Q.value = 0.9;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(gainPeak, when + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.001, when + duration);

  src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  src.start(when); src.stop(when + duration);
}

// A quick downward pitch slide reads as impact/weight, not a musical tone.
function playThump(ctx, when, duration, startFreq, endFreq, gainPeak) {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(startFreq, when);
  osc.frequency.exponentialRampToValueAtTime(endFreq, when + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(gainPeak, when + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, when + duration);

  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(when); osc.stop(when + duration);
}

// The one hit sound in the game — layers the noise "crack" with the pitch
// thump. `power` (0..1) brightens and loudens both layers so a power shot
// or power serve genuinely sounds harder-hit than a soft rally touch or a
// lob, without needing separate sound assets per shot type.
function playHitSound(power = 0.45) {
  const ctx = getAudioCtx();
  if (!ctx) return; // WebAudio unsupported — already warned in getAudioCtx()
  if (ctx.state !== 'running') ctx.resume().catch(() => {}); // keep nudging it — scheduling below is safe either way
  try {
    const now = ctx.currentTime;
    const p = Math.max(0, Math.min(1, power));
    playNoiseBurst(ctx, now, 0.05 + p * 0.02, 1800 + p * 1400, 0.5 + p * 0.35);
    playThump(ctx, now, 0.09 + p * 0.03, 180 + p * 90, 60, 0.35 + p * 0.25);
  } catch (err) {
    console.warn('Hit sound failed:', err);
  }
}

// A synthesized crowd reaction played once per point (from awardPoint()),
// scaled by `intensity` (0..1) — how big a moment it was (a routine point
// gets a murmur, a break/game/match point or a long streak gets a real
// roar). Built the same way as the hit sound: no audio files, just layered
// WebAudio. A wide bandpassed noise burst reads as the crowd's collective
// murmur/roar; a handful of short randomly-pitched blips scattered across
// the roar sell individual voices, not just one flat wash of noise.
function playCrowdCheer(intensity = 0.5) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  try {
    const now = ctx.currentTime;
    const i = Math.max(0, Math.min(1, intensity));
    const dur = 0.5 + i * 0.9;
    playNoiseBurst(ctx, now, dur, 500 + i * 500, 0.16 + i * 0.30);
    const whoops = Math.round(2 + i * 5);
    for (let w = 0; w < whoops; w++) {
      const when = now + Math.random() * dur * 0.7;
      const freq = 260 + Math.random() * 340;
      playThump(ctx, when, 0.12 + Math.random() * 0.08, freq, freq * 0.6, 0.05 + i * 0.07);
    }
  } catch (err) {
    console.warn('Crowd cheer failed:', err);
  }
}

// ── COURT GEOMETRY ────────────────────────────────────────────────────
const W = 400, H = 560;
const CL = 42, CR = 358, CT = 28, CB = 532;
const NET_Y = H / 2;
const svcT = CT + (NET_Y - CT) * 0.38;
const svcB = CB - (CB - NET_Y) * 0.38;

function boxRect(end, side) {
  const yTop = end === 'top' ? svcT : NET_Y;
  const yBot = end === 'top' ? NET_Y : svcB;
  const xLeft  = side === 'left' ? CL : W / 2;
  const xRight = side === 'left' ? W / 2 : CR;
  return { x: xLeft, y: yTop, w: xRight - xLeft, h: yBot - yTop };
}
function centerOfHalf(side) { return side === 'left' ? (CL + W/2)/2 : (W/2 + CR)/2; }

// ── COURT SURFACES ───────────────────────────────────────────────────
// Each surface scales ball speed and spin/curve relative to the baseline
// physics tuned on the original (clay-like) court. speedMult scales every
// ball speed (rally, power, serve) so higher = faster-playing surface.
// spinMult scales how hard a slice curves — higher = ball "grips" the
// surface more and curves harder; grass has low grip so shots stay flatter
// and reward raw pace instead. aiSpeedMult nudges the AI's reaction speed
// so faster surfaces also feel more pressured, not just faster-looking.
const COURTS = {
  clay:  { name: 'Clay',       color: '#c04a28', colorDark: '#7c3010', lineColor: '#f0ede4',
           speedMult: 0.85, spinMult: 1.35, aiSpeedMult: 0.92,
           blurb: 'Slower ball, big bounce, spin bites hard.',
           // Clay's orange-red is too close to the default power-shot
           // orange, so swap power to a bright cyan on this surface.
           ballColors: { regular: '#d8e018', power: '#2fe0ff', slice: '#5adcb4' } },
  grass: { name: 'Grass',      color: '#3f8c3f', colorDark: '#2c6b2c', lineColor: '#f8f6ee',
           speedMult: 1.18, spinMult: 0.65, aiSpeedMult: 1.08,
           blurb: 'Fast and low — power beats spin here.',
           // The classic problem: a yellow-green ball vanishes on grass.
           // Push the regular ball toward a brighter, whiter yellow, and
           // swap power/slice (orange and teal both too close to grass
           // green) for hot pink and violet-blue.
           ballColors: { regular: '#f5f000', power: '#ff2fb0', slice: '#7a5cff' } },
  hard:  { name: 'Hard Court', color: '#2f6fa3', colorDark: '#1f4f78', lineColor: '#f0ede4',
           speedMult: 1.0,  spinMult: 1.0,  aiSpeedMult: 1.0,
           blurb: 'Balanced pace and bounce — the all-rounder.',
           // Default palette reads fine against the blue hard court.
           ballColors: { regular: '#d8e018', power: '#ff7a28', slice: '#5adcb4' } },
};

// Fallback palette used before a court is chosen (e.g. the toss ball on the
// court-select screen background, which is never shown, but keeps this
// safe if called with no currentCourt yet).
const DEFAULT_BALL_COLORS = { regular: '#d8e018', power: '#ff7a28', slice: '#5adcb4' };
function currentBallColors() {
  return (COURTS[currentCourt] && COURTS[currentCourt].ballColors) || DEFAULT_BALL_COLORS;
}
let currentCourt = null; // set when the player picks a surface on the select screen

// ── RACKET LOADOUTS (player-only equipment choice) ──────────────────
// A pre-match choice (see the 'loadout-select' screen) that trades off the
// PLAYER's own stats — never the AI's, this is purely the human's equipment.
// Each multiplier is applied at its own specific point in the physics
// (playerReachY/X for reachMult, the player's footspeed in applyCourt() for
// speedMult, the isPlayer branch of a power shot/serve in doBounce()/
// launchServe() for powerMult, and the isPlayer branch of a slice in
// doBounce() for spinMult) rather than folding into the shared COURTS
// multipliers, since those apply identically to both sides and this must
// only ever touch the player. Deliberately balanced so no loadout is a
// strict upgrade over All-Court — every bonus here costs something else.
const LOADOUTS = {
  allcourt: { name: 'All-Court', blurb: 'Balanced in every category — a safe, complete game.',
    speedMult: 1.0, powerMult: 1.0, spinMult: 1.0, reachMult: 1.0 },
  power:    { name: 'Power', blurb: 'Real pace on power shots and power serves, from a stiffer, less forgiving frame.',
    speedMult: 0.95, powerMult: 1.20, spinMult: 0.85, reachMult: 0.85 },
  control:  { name: 'Control', blurb: 'A big, forgiving sweet spot — at the cost of raw power.',
    speedMult: 1.0, powerMult: 0.85, spinMult: 1.0, reachMult: 1.25 },
  spin:     { name: 'Spin', blurb: 'Whippy strings bite hard for a nasty slice, but shots come off softer.',
    speedMult: 1.0, powerMult: 0.88, spinMult: 1.40, reachMult: 0.95 },
};
const LOADOUT_ORDER = ['allcourt', 'power', 'control', 'spin'];
let currentLoadout = 'allcourt'; // persists across matches until the player changes it from the select screen

// Per-loadout shirt/racket-grip accent so the equipment choice is visible
// during play, not just a hidden stat change — see currentPlayerPalette().
const LOADOUT_ACCENT = {
  allcourt: { c: '#1d6fd6', d: '#0d4a95' },
  power:    { c: '#e0522a', d: '#a3341a' },
  control:  { c: '#2a9e7a', d: '#1a6e54' },
  spin:     { c: '#8a4ae0', d: '#5e2ea3' },
};

// ── PIXEL-ART CHARACTER SYSTEM ────────────────────────────────────────
// A detailed retro sprite: 14x21 grid (much larger/more detailed than the
// original 8x12 grid) covering hair, a full face (eyebrows, two eyes, a
// nose shade, a mouth), shirt with shading, shorts, socks, and shoes. The
// hitting arm + racket are NOT baked into the grid — they're drawn
// separately as chunky square "pixels" along an exact hand path, so the
// racket can be precisely anchored to the hand at every swing frame
// (matching how the old vector version tracked hand position) while still
// rendering blocky/retro instead of smooth curves.
const PXS = 3.2;               // body pixel scale (size of one grid cell, px)
const GW = 14, GH = 21;
const PX = GW * PXS, PY = GH * PXS; // overall footprint, same role as before

// Rows 15-20 (legs/socks/shoes) were removed from the static grid — the legs
// are now drawn procedurally by drawLegs() so they can actually swing when
// the character moves (see WALK ANIMATION below), the same way the hitting
// arm was already drawn separately from this grid instead of baked in. GH
// stays 21 (see PX/PY below) so every existing anchor formula that measures
// a fraction of the character's total height is unaffected — the grid just
// no longer fills the bottom 6 rows of that height, drawLegs() does.
const BODY_GRID = [
 "..hhhhhhh.....", //0  hair
 ".hhssssssh....", //1  hair sides + forehead
 ".hsssssssh....", //2
 ".rswwsswwr....", //3  ears + fuller eyebrows
 ".rsepssper....", //4  ears + two-tone eyes (white + pupil)
 ".hsssssssh....", //5
 "..sskjsss.....", //6  nose shade + highlight
 "..ssmmsss.....", //7  mouth (2px)
 "..ssssss......", //8  chin
 "...snns.......", //9  neck
 "..cccccc......", //10 shoulders
 ".ccccccccc....", //11
 ".ccccccccc....", //12
 ".dccccccd.....", //13 shirt shade
 "..ccxxcc......", //14 shorts
];

const PAL_P = {
  h:'#2c1200', s:'#f2c197', w:'#1f0e00', p:'#1a1208', k:'#dba572', m:'#8a3d2c',
  n:'#dba572', c:'#1d6fd6', d:'#0d4a95', x:'#1b2f66', l:'#f0ede4', o:'#e8e4da',
  e:'#f8f4ea', j:'#f8dab0', r:'#dba572',
};
const PAL_A = {
  h:'#601010', s:'#f2c197', w:'#3a0808', p:'#1a1208', k:'#dba572', m:'#8a3d2c',
  n:'#dba572', c:'#e1483f', d:'#ad2c26', x:'#3a1010', l:'#f0ede4', o:'#e8e4da',
  e:'#f8f4ea', j:'#f8dab0', r:'#dba572',
};

// The player's palette with the shirt ('c') and racket-grip ('d') colors
// swapped for the current loadout's accent — recomputed each draw (a plain
// object spread, cheap) rather than mutating PAL_P itself, so PAL_P stays
// the true default. drawPixelRacket() reads pal.d for the grip, so this is
// the same touch point that colors the racket, not just the shirt.
function currentPlayerPalette() {
  const accent = LOADOUT_ACCENT[currentLoadout] || LOADOUT_ACCENT.allcourt;
  return { ...PAL_P, c: accent.c, d: accent.d };
}

function mirrorRow(row) { return row.split('').reverse().join(''); }

// A crisp 1px-ish dark outline drawn around the sprite's true silhouette
// (only along edges that actually border empty space, not a blanket
// drop-shadow) before the fill pass, so every character reads as a clean
// "cut out sticker" against the court the way a modern pixel-art platformer
// character does, instead of just flat color blocks with no edge definition.
const SPRITE_OUTLINE = '#1a1008';
function drawSpriteOutline(rows, ox, oy) {
  const OL = Math.max(1, Math.round(PXS * 0.26));
  cx.fillStyle = SPRITE_OUTLINE;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '.') continue;
      const x = Math.round(ox + c*PXS), y = Math.round(oy + r*PXS);
      const s = Math.ceil(PXS);
      if (r === 0 || rows[r-1][c] === '.') cx.fillRect(x - OL, y - OL, s + OL*2, OL);
      if (r === rows.length-1 || rows[r+1][c] === '.') cx.fillRect(x - OL, y + s, s + OL*2, OL);
      if (c === 0 || row[c-1] === '.') cx.fillRect(x - OL, y - OL, OL, s + OL*2);
      if (c === row.length-1 || row[c+1] === '.') cx.fillRect(x + s, y - OL, OL, s + OL*2);
    }
  }
}

// Fake "3D" volume on an otherwise flat pixel-art fill, the same way a
// cel-shaded 2D sprite reads as rounded: a per-cell horizontal light/shadow
// blend (light from the left side of the BODY, not the screen — see the
// flip handling below) so every limb and the torso reads as a lit cylinder
// rather than a flat color swatch, plus one soft diagonal sheen clipped to
// the sprite's true silhouette on top, matching the highlight the tennis
// ball already gets from its own radial gradient. Both passes reuse the
// existing lighten/darkenColor blend helpers (defined near the ball code)
// so the whole game shares one consistent "light source" feel.
const SPRITE_LIGHT_MAX = 0.20;
const SPRITE_SHADE_MAX = 0.30;
function drawGrid(grid, pal, ox, oy, flip, flashA) {
  const rows = grid.map(row => flip ? mirrorRow(row) : row);
  drawSpriteOutline(rows, ox, oy);
  const cols = rows[0].length;
  const silhouette = new Path2D();
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < cols; c++) {
      const k = row[c];
      if (k === '.') continue;
      const x = Math.round(ox + c*PXS), y = Math.round(oy + r*PXS);
      const s = Math.ceil(PXS);
      silhouette.rect(x, y, s, s);
      // Light direction is fixed to the CHARACTER's own left side (not the
      // screen's), so a flipped (AI) sprite still shades as if lit from its
      // own left shoulder instead of the light flopping to the other side
      // the instant a character faces the other way.
      const lightCol = flip ? (cols - 1 - c) : c;
      const t = lightCol / (cols - 1); // 0 = character's left (lit) .. 1 = right (shadowed)
      const base = pal[k] || '#ff00ff';
      cx.fillStyle = t < 0.5
        ? blendColor(base, 255, (0.5 - t) * 2 * SPRITE_LIGHT_MAX)
        : blendColor(base, 0, (t - 0.5) * 2 * SPRITE_SHADE_MAX);
      cx.fillRect(x, y, s, s);
      if (flashA > 0.05) {
        cx.fillStyle = `rgba(255,255,255,${flashA})`;
        cx.fillRect(x, y, s, s);
      }
    }
  }
  // One soft top-left sheen over the whole silhouette on top of the per-cell
  // shading — the extra bit of roundness that sells "lit form" rather than
  // "shaded blocks."
  cx.save();
  cx.clip(silhouette);
  const gw = cols * PXS, gh = rows.length * PXS;
  const sheen = cx.createRadialGradient(ox + gw*0.28, oy + gh*0.18, 0, ox + gw*0.28, oy + gh*0.18, gw*0.9);
  sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = sheen;
  cx.fillRect(ox, oy, gw, gh);
  cx.restore();
}

// Chunky pixel-block arm: a row of square blocks from the shoulder to the
// hand, so it reads as blocky/retro while still having an exact endpoint.
function drawArmBlocks(shX, shY, handX, handY, skinColor, blockSize) {
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = shX + (handX - shX) * t, y = shY + (handY - shY) * t;
    const bx = Math.round(x - blockSize/2), by = Math.round(y - blockSize/2);
    cx.fillStyle = skinColor;
    cx.fillRect(bx, by, blockSize, blockSize);
    // A tiny corner bevel per block — light top-left, shadow bottom-right —
    // so the arm reads as a rounded cylinder instead of flat skin-colored
    // squares, matching the body's own cel-shading direction.
    const half = blockSize / 2;
    cx.fillStyle = 'rgba(255,255,255,0.22)';
    cx.fillRect(bx, by, half, half);
    cx.fillStyle = 'rgba(0,0,0,0.22)';
    cx.fillRect(bx + half, by + half, half, half);
  }
}

// Pixel-art racket: blocky grip + throat + an oval stringed head built
// from coarse square blocks (not smooth curves), rotated to match the
// forearm angle and anchored exactly at the hand.
// Head runs x=6..16 (length 10) at half-width up to 4 (width 9, via the
// same +1 top/bottom asymmetry the taper blocks always had) — a real
// racket head is longer than it is wide, so length now edges out width
// instead of the reverse (was x=6..12, length 6, noticeably squatter
// than the width).
function drawPixelRacket(handX, handY, angle, gripColor, px) {
  cx.save();
  cx.translate(Math.round(handX), Math.round(handY));
  cx.rotate(angle);
  const blocks = [
    [0,-1,4,2,'g'], [4,-1,2,2,'h'],
    // top edge: hw2 tip taper, hw3 taper, hw4 flat (x8-13), hw3, hw2 tip
    [6,-2,1,1,'o'],[7,-3,1,1,'o'],[8,-4,6,1,'o'],[14,-3,1,1,'o'],[15,-2,1,1,'o'],
    // bottom edge, mirrored
    [6,2,1,1,'o'],[7,3,1,1,'o'],[8,4,6,1,'o'],[14,3,1,1,'o'],[15,2,1,1,'o'],
    // solid frame at the two narrow tip columns (too pinched for string)
    [6,-1,1,2,'o'],[15,-1,1,2,'o'],
    [7,-3,8,6,'t'],
  ];
  const pal = { g: gripColor, h: '#333', o: '#262626', t: '#f0f0f0' };
  for (const [bx,by,bw,bh,key] of blocks) {
    cx.fillStyle = pal[key];
    cx.fillRect(Math.round(bx*px), Math.round(by*px), Math.ceil(bw*px), Math.ceil(bh*px));
  }
  // A light/shadow split down the grip, same rounded-volume cue as the arm
  // and body — the single biggest flat color block on the racket, so it's
  // the one most worth giving a bit of roundness.
  cx.fillStyle = 'rgba(255,255,255,0.2)';
  cx.fillRect(0, -1*px, 4*px, 1*px);
  cx.fillStyle = 'rgba(0,0,0,0.22)';
  cx.fillRect(0, 0, 4*px, 1*px);
  cx.strokeStyle = 'rgba(120,120,120,0.8)'; cx.lineWidth = 1;
  for (let i = 0; i < 8; i++) { cx.beginPath(); cx.moveTo((7+i)*px, -3*px); cx.lineTo((7+i)*px, 3*px); cx.stroke(); }
  for (let j = 0; j < 3; j++) { cx.beginPath(); cx.moveTo(7*px, (-3+2*j)*px); cx.lineTo(15*px, (-3+2*j)*px); cx.stroke(); }
  cx.restore();
}

// ── WALK ANIMATION (legs + torso bob) ──────────────────────────────────
// The legs were removed from BODY_GRID's static art (see its comment) so
// they can swing here instead — each leg is a simple two-tone block column
// (sock, then shoe) hung from a fixed hip point, exactly like drawArmBlocks
// hangs the arm from the shoulder. `walkPhase` is a free-running angle that
// only advances while the pad is actually moving (see updateWalkAnim(),
// called from movePlayer()/moveAI()), and `walkAmount` (0..1) eases toward
// 1 while moving / 0 while still, so the swing amplitude itself fades out
// rather than snapping a mid-stride leg straight the instant you stop.
const LEG_SOCK_ROWS = 4, LEG_SHOE_ROWS = 2; // matches the row count the old static sock/shoe rows had
const LEG_W = 2.1 * PXS;
const LEG_SWING_MAX = 3.6; // px of fore/aft hip swing at full walkAmount
const BODY_BOB_MAX = 1.6;  // px the torso sinks at each footfall while moving
function drawLeg(hipX, hipTopY, swingPx, sockColor, shoeColor) {
  const sockH = LEG_SOCK_ROWS * PXS, shoeH = LEG_SHOE_ROWS * PXS;
  const x = Math.round(hipX - LEG_W/2 + swingPx), y = Math.round(hipTopY);
  const w = Math.ceil(LEG_W);
  cx.fillStyle = sockColor;
  cx.fillRect(x, y, w, Math.ceil(sockH));
  cx.fillStyle = shoeColor;
  cx.fillRect(x, y + Math.round(sockH), w, Math.ceil(shoeH));
  // Same light-left/shadow-right cel-shading split the rest of the body
  // uses, so the legs read as rounded rather than flat rectangles.
  const bevel = Math.max(1, Math.round(LEG_W * 0.32));
  cx.fillStyle = 'rgba(255,255,255,0.18)';
  cx.fillRect(x, y, bevel, Math.ceil(sockH + shoeH));
  cx.fillStyle = 'rgba(0,0,0,0.2)';
  cx.fillRect(x + w - bevel, y, bevel, Math.ceil(sockH + shoeH));
}
// Advances the walk cycle for one pad — `moving` is whether it actually
// covered ground this frame (see the call sites in movePlayer()/moveAI()).
const WALK_PHASE_SPEED = 0.4;
function updateWalkAnim(pad, moving) {
  if (moving) {
    pad.walkPhase += WALK_PHASE_SPEED;
    pad.walkAmount = Math.min(1, pad.walkAmount + 0.25);
  } else {
    pad.walkAmount = Math.max(0, pad.walkAmount - 0.18);
  }
}

// Draws the full pixel-art character + arm + racket, centered at `cx0`
// with feet at `feetY`. Returns the hand position (kept for API parity,
// though the racket is now drawn internally rather than by the caller).
function drawPerson(pal, cx0, feetY, isPlayer, facing, armSwing, flashA, walkPhase = 0, walkAmount = 0) {
  const dir = facing;
  const flip = !isPlayer;
  const w = PX, h = PY;
  const ox = cx0 - w/2, oy = feetY - h;

  // A soft grounding shadow under the feet — cheap, but it's what actually
  // sells a flat pixel sprite as standing ON the court instead of floating
  // pasted over it, the same trick every platformer character shadow does.
  // Stays anchored at the true feetY (not the bobbing torso below) since a
  // real ground shadow doesn't bounce with the body.
  cx.save();
  cx.fillStyle = 'rgba(0,0,0,0.32)';
  cx.beginPath();
  cx.ellipse(cx0, feetY + 2, w*0.34, w*0.1, 0, 0, Math.PI*2);
  cx.fill();
  cx.restore();

  // Legs: two swinging blocks hung from a fixed hip line, opposite phase so
  // they alternate like a real stride. Drawn BEFORE the torso so the torso's
  // bob (below) can overlap their tops by a pixel or two with no gap ever
  // showing at the hip seam.
  const hipY = oy + 15*PXS;
  const leftHipX = ox + 2.55*PXS, rightHipX = ox + 6.95*PXS;
  const swing = Math.sin(walkPhase) * LEG_SWING_MAX * walkAmount;
  drawLeg(leftHipX, hipY, swing, pal.l, pal.o);
  drawLeg(rightHipX, hipY, -swing, pal.l, pal.o);

  // Torso bob: the upper body (and the arm hanging off it) sinks a couple
  // px at each footfall — twice per full walkPhase cycle, one per step —
  // and fades out with walkAmount exactly like the leg swing does.
  const bob = (1 - Math.cos(walkPhase*2)) * 0.5 * BODY_BOB_MAX * walkAmount;
  const boy = oy + bob;

  drawGrid(BODY_GRID, pal, ox, boy, flip, flashA);

  const shGridCol = isPlayer ? 10.5 : 3.5;
  const shX = ox + shGridCol*PXS, shY = boy + 11*PXS;

  const restHandX = shX + dir*w*0.02, restHandY = boy + h*0.78;
  const strikeHandX = shX + dir*w*0.34, strikeHandY = boy + h*0.30;
  const handX = restHandX + (strikeHandX - restHandX) * armSwing;
  const handY = restHandY + (strikeHandY - restHandY) * armSwing;

  drawArmBlocks(shX, shY, handX, handY, pal.s, PXS*1.1);

  const restAngle = Math.PI*0.5;
  const strikeAngle = dir > 0 ? -0.25 : Math.PI + 0.25;
  const angle = restAngle + (strikeAngle - restAngle) * armSwing;
  drawPixelRacket(handX, handY, angle, pal.d, 1.7);

  return { handX, handY, elbowX: (shX+handX)/2, elbowY: (shY+handY)/2 };
}

// ── GAME STATE ────────────────────────────────────────────────────────
// player.y / ai.y now actually vary — each can roam their full half of the
// court (baseline to net) rather than being pinned to one fixed row. See
// the NET-RUSHING MOVEMENT section below for the exact bounds.
const player = { x: W/2-44, y: CB-14, w: 88, h: 10, speed: 5, pts: 0, games: 0, color: '#4ab8f0',
  hitTimer: 0, flashAlpha: 0, lastShotType: 'regular', windup: 0, contactX: 0, contactY: 0, hasHit: false,
  walkPhase: 0, walkAmount: 0 };
const ai = { x: W/2-44, y: CT+2, w: 88, h: 10, speed: 3.7, pts: 0, games: 0, color: '#f07070',
  hitTimer: 0, flashAlpha: 0, lastShotType: 'regular', windup: 0, contactX: 0, contactY: 0, hasHit: false, attackStreak: 0, committedToNet: false, hitsThisPoint: 0,
  walkPhase: 0, walkAmount: 0 };
const ball = { x: W/2, y: H/2, r: 7, dx: 0, dy: 0, speed: 5.5, spin: 0, shotType: 'regular',
  isLob: false, lobStartX: 0, lobStartY: 0, lobTargetX: 0, lobTargetY: 0, lobT: 0, lobDuration: 1, lobHeight: 0,
  serveDifficulty: 0, // 0..1, set at launchServe() — see SERVE_PLACEMENT_REACH_PENALTY_MAX
  // Latches true the moment a side is caught up at net during a live lob's
  // flight, and STAYS true even if that side then retreats out of the net
  // zone before the ball lands — a real player caught out at net by a lob
  // doesn't get to un-cook it by sprinting back in time. See the gating in
  // update()'s PLAYING section.
  lobCaughtPlayer: false, lobCaughtAi: false,
  // DROP SHOT — a second target-based flight, mirroring the lob fields
  // above but flown much shorter/shallower (see advanceDrop()). Mutually
  // exclusive with isLob; never both true at once.
  isDrop: false, dropStartX: 0, dropStartY: 0, dropTargetX: 0, dropTargetY: 0,
  dropT: 0, dropDuration: 1, dropHeight: 0,
  // 0..1 — how close to the net the PLAYER was standing on their last shot.
  // Set in doBounce() whenever the player hits, read by aiReachY() so a shot
  // struck from up close is genuinely harder for the AI to track down, not
  // just faster. Left alone (not reset) when the AI hits — only the
  // player's own net-rush shots should shrink the AI's coverage.
  lastPlayerNetCloseness: 0 };

// ── NET-RUSHING MOVEMENT (2D positioning) ───────────────────────────
// Each side can now move anywhere within their own half of the court —
// side to side AND toward/away from the net — instead of being pinned to
// one fixed row at the baseline. NET_BUFFER keeps a hitbox from literally
// overlapping the net band/posts, and BASELINE_BUFFER keeps it from
// clipping the very back line, matching the padding the old fixed rows
// used (CB-14 / CT+2).
const NET_BUFFER = 14;      // closest a pad's near-edge may get to NET_Y
const BASELINE_BUFFER = 2;  // closest a pad's far-edge may get to its baseline
// Player (bottom half): y is the pad's TOP edge (matches pad.h below it).
function playerYBounds() { return { lo: NET_Y + NET_BUFFER, hi: CB - player.h - BASELINE_BUFFER }; }

// HARD net-rush lockout: the AI is PHYSICALLY unable to move any closer to
// the net than its own service line (svcT) until it has struck the ball
// AI_HITS_BEFORE_NET_ALLOWED times in the current point. This is a real
// positional wall, not a probability or a preference — earlier attempts to
// discourage net-rushing by making it statistically rarer (longer rallies
// required, lower commit chance, etc.) kept not being enough, because the
// AI could still physically reach net-adjacent Y whenever it needed to
// intercept a shallow ball, regardless of what it had "decided." Clamping
// aiYBounds().hi itself means there is no code path — interception,
// recovery, or otherwise — that can put the AI's racket-edge past the
// service line before it's earned the right to be there.
const AI_HITS_BEFORE_NET_ALLOWED = 5;
// AI (top half): y is likewise the pad's TOP edge.
// `ignoreNetLockout` bypasses the net-rush lockout below and always returns
// the true (unlocked) net-side bound. Used in exactly two places: computing
// a drop shot's landing depth (doBounce()'s 'drop' branch) and the AI's
// chase target while one is actually in flight toward it (moveAI()) — see
// those call sites for why. Every other caller (recovery positioning, the
// AI's own decision to attack) gets the normal locked behavior unchanged.
function aiYBounds(ignoreNetLockout) {
  const lo = CT + BASELINE_BUFFER;
  const fullHi = NET_Y - NET_BUFFER - ai.h;
  if (!ignoreNetLockout && (ai.hitsThisPoint || 0) < AI_HITS_BEFORE_NET_ALLOWED) {
    // Locked to the service line — svcT is the near-net edge of the AI's
    // service box, so clamp the pad's net-facing edge (y + ai.h) there.
    const lockedHi = Math.min(fullHi, svcT - ai.h);
    return { lo, hi: Math.max(lo, lockedHi) };
  }
  return { lo, hi: fullHi };
}

// Where a RETURNER starts, as opposed to the server (who must be at the
// true baseline). 0.72 = 72% of the way from net to baseline — a realistic
// "waiting to return" depth, close enough to the baseline to still handle
// a deep serve, but with meaningfully less ground to cover on a serve that
// lands short, compared to starting all the way back at the true baseline.
const RETURN_READY_DEPTH = 0.72;
function returnReadyY(bounds) { return bounds.lo + RETURN_READY_DEPTH * (bounds.hi - bounds.lo); }

const STRIKE_FRAMES = 20;

// Baseline physics (tuned on a neutral hard-court feel, speedMult=1). Every
// surface scales these via applyCourt() before the match starts, so the
// same collision/serve code produces a genuinely different feel per court
// without duplicating any game logic.
// All speeds below carry a flat SPEED_TUNE multiplier (applied where each
// constant is defined). Was pushed up to 1.32 across two earlier requests
// for a faster game; brought back to the untuned 1.0 baseline because
// rallies had gotten too fast to react to.
const SPEED_TUNE = 1.0; // was 1.32
const BASE_MAX_SPD = 12 * SPEED_TUNE, BASE_MAX_SPD_POWER = 17 * SPEED_TUNE, BASE_POWER_MULT = 2.4;
const BASE_SLICE_CURVE = 0.26, BASE_SPIN_DECAY = 0.97;
const BASE_SERVE_SPEED = 6.5 * SPEED_TUNE, BASE_SERVE_SPEED_POWER = 10 * SPEED_TUNE;
const BASE_AI_SPEED = 3.7 * SPEED_TUNE;
const SLICE_MIN_OFFSET = 0.4; // guarantees a visible curve even on a near-center hit
const SERVE_BAR_SPEED = 0.021;
const ZONE_WIDTH = 0.22;
const POWER_WINDOW_WIDTH = 0.07;
const BASE_AI_SERVE_SUCCESS = 0.78, BASE_AI_SERVE_POWER_CHANCE = 0.28;
// Mutable so tournament opponents can override them per-round; exhibition
// mode (and the pre-tournament default) uses the base values as-is.
let AI_SERVE_SUCCESS = BASE_AI_SERVE_SUCCESS, AI_SERVE_POWER_CHANCE = BASE_AI_SERVE_POWER_CHANCE;

// ── SERVE AIM (placement risk/reward) ───────────────────────────────
// The player steers a small crosshair inside the target service box with
// arrow/WASD while the timing bar runs. Dead center is the easiest target
// (full-width timing zone); the corners are hardest (narrowest zone) but
// pay off with a faster serve and a placement the AI struggles to reach.
const AIM_MOVE_SPEED = 0.028;      // normalized units/frame the crosshair can travel
const ZONE_WIDTH_MIN = 0.09;       // narrowest the timing zone shrinks to, at a corner
const POWER_WIDTH_MIN = 0.025;     // narrowest the power window shrinks to, at a corner
const AIM_SPEED_BONUS_MAX = 0.35;  // extra fraction of serve speed at a full-corner placement
// The actual "struggles to reach" payoff for a tough placement — not just
// extra pace, but genuinely less forgiveness on the return, exactly like
// the net-closeness reach penalty below but keyed off serve difficulty
// instead. Only live during the return-of-serve window (gState ===
// 'serve-flight') — once the point turns into a normal rally, this serve's
// placement has already done its job and shouldn't keep shrinking reach on
// every later shot.
const SERVE_PLACEMENT_REACH_PENALTY_MAX = 0.45;
function servePlacementReachMult() {
  return gState === 'serve-flight' ? 1 - ball.serveDifficulty * SERVE_PLACEMENT_REACH_PENALTY_MAX : 1;
}
let aimX = 0.5, aimY = 0.5; // normalized [0,1] position within the target service box

// Distance-from-center difficulty, 0 at the box center up to 1 at a corner.
// Uses Chebyshev-ish blending (both axes contribute) so the sides and the
// corners are both harder than dead center, corners hardest of all.
function aimDifficulty(nx, ny) {
  const dx = Math.abs(nx - 0.5) * 2; // 0 center -> 1 edge
  const dy = Math.abs(ny - 0.5) * 2;
  return Math.min(1, Math.sqrt(dx*dx + dy*dy) / Math.SQRT2);
}
function currentZoneWidth(diff) { return ZONE_WIDTH - (ZONE_WIDTH - ZONE_WIDTH_MIN) * diff; }
function currentPowerWidth(diff) { return POWER_WINDOW_WIDTH - (POWER_WINDOW_WIDTH - POWER_WIDTH_MIN) * diff; }

// Recomputes zoneStart/zoneEnd/powerStart/powerEnd around the SAME zone
// center whenever the aim target moves, so difficulty updates live instead
// of only at the start of the point. The zone's center position along the
// timing bar is fixed per-point (zoneCenter); only its WIDTH changes here.
let zoneCenter = 0.51, powerCenterOffset = 0.03; // powerCenterOffset: power window's offset from zoneCenter
function recomputeServeZones() {
  const diff = aimDifficulty(aimX, aimY);
  const zw = currentZoneWidth(diff), pw = currentPowerWidth(diff);
  zoneStart = Math.max(0, Math.min(1 - zw, zoneCenter - zw/2));
  zoneEnd = zoneStart + zw;
  let pStart = zoneStart + (zoneEnd - zoneStart - pw) * powerCenterOffset;
  pStart = Math.max(zoneStart, Math.min(zoneEnd - pw, pStart));
  powerStart = pStart;
  powerEnd = powerStart + pw;
}

// Live (surface-scaled) values — set by applyCourt() once a court is picked.
let MAX_SPD = BASE_MAX_SPD, MAX_SPD_POWER = BASE_MAX_SPD_POWER, POWER_MULT = BASE_POWER_MULT;
let SLICE_CURVE = BASE_SLICE_CURVE, SPIN_DECAY = BASE_SPIN_DECAY;
let SERVE_SPEED = BASE_SERVE_SPEED, SERVE_SPEED_POWER = BASE_SERVE_SPEED_POWER;

// ── ABSOLUTE BALL SPEED CAP ──────────────────────────────────────────
// A true hard ceiling on the ball's actual resultant speed (sqrt(dx²+dy²)),
// independent of shot type, court surface, or the net-proximity bonus.
// This did NOT exist before: MAX_SPD/MAX_SPD_POWER only capped the pre-bonus
// dy magnitude, but the net-rush speed bonus was then multiplied onto that
// already-clamped ceiling too (Math.min(x*bonus, cap*bonus) scales the cap
// right along with the value it's supposed to be limiting), and dx was never
// capped at all. So a power shot, on grass, hit right at the net could
// exceed the "cap" by a meaningful margin, and the sideways component had
// no limit whatsoever. BALL_MAX_SPEED_BASE is set with headroom above the
// highest speed any single intended mechanic produces on its own, scaled by
// the current court's speedMult so faster surfaces still feel faster
// relative to each other — but nothing, from any combination of bonuses,
// can ever push the ball past this.
const BALL_MAX_SPEED_BASE = 19 * SPEED_TUNE;
let BALL_MAX_SPEED = BALL_MAX_SPEED_BASE;
function clampBallSpeed() {
  const spd = Math.hypot(ball.dx, ball.dy);
  if (spd > BALL_MAX_SPEED) {
    const scale = BALL_MAX_SPEED / spd;
    ball.dx *= scale; ball.dy *= scale;
  }
}

function applyCourt(courtKey) {
  currentCourt = courtKey;
  const c = COURTS[courtKey];
  MAX_SPD = BASE_MAX_SPD * c.speedMult;
  MAX_SPD_POWER = BASE_MAX_SPD_POWER * c.speedMult;
  POWER_MULT = BASE_POWER_MULT; // relative boost stays the same; absolute speed already scaled via MAX_SPD_POWER
  SLICE_CURVE = BASE_SLICE_CURVE * c.spinMult;
  SERVE_SPEED = BASE_SERVE_SPEED * c.speedMult;
  SERVE_SPEED_POWER = BASE_SERVE_SPEED_POWER * c.speedMult;
  BALL_MAX_SPEED = BALL_MAX_SPEED_BASE * c.speedMult;
  ball.speed = 5.5 * SPEED_TUNE * c.speedMult;
  player.speed = 5 * LOADOUTS[currentLoadout].speedMult; // surface-independent; scaled only by the player's own loadout
  // opponentSpeedMult layers the current tournament opponent's difficulty
  // (1 outside tournament mode) on top of the court's own aiSpeedMult.
  ai.speed = BASE_AI_SPEED * c.aiSpeedMult * opponentSpeedMult;
}

let gState = 'title';
// Freezes the live match (any state not in FROZEN_STATES) without touching
// gState itself — lots of draw logic branches on the exact gState value
// (serving vs. playing vs. point-end, etc.), so pausing by swapping gState
// to a 'paused' state would break all of that. Instead update() just bails
// out for a frame, and draw() renders the frozen frame plus an overlay.
let paused = false;
// Drawn as an overlay on top of whatever's currently on screen (the title
// screen, or a paused match) rather than as its own gState, so opening it
// never disturbs the screen underneath — closing it just goes back to
// exactly what was already showing.
let showControls = false;
let currentServer = 'player';
let serverSide = 'right';
let targetSide = 'left';
let faultCount = 0;
let rally = 0;
let endTimer = 0, faultTimer = 0, aiDelay = 0;
let ptWin = null, pointReason = 'normal', gameOverPending = false;
let serveLineY = 0, servePrevSide = 0;
let missType = null; // 'net' | 'long' | 'wide' | null — how a missed serve actually fails
let serveBarPos = 0, serveBarDir = 1;
let zoneStart = 0.4, zoneEnd = 0.62, powerStart = 0.47, powerEnd = 0.54;

// ── SERVE TOSS ANIMATION ────────────────────────────────────────────
// A one-shot toss-up-and-overhead-hit animation that plays AFTER the serve
// is committed (Space press for the player / aiDelay expiring for the AI),
// not while the player is still lining up the shot. The timing-bar skill
// mechanic is untouched: success/power is still decided at the exact moment
// of commit, using serveBarPos against zoneStart/zoneEnd/powerStart/powerEnd
// exactly as before. Only the ball no longer bounces during the wait — it's
// treated as held (not drawn) until the toss animation begins.
const TOSS_PEAK_HEIGHT = 68; // px above the server's racket-hand height
const TOSS_ANIM_FRAMES = 25; // total length of the one-shot toss+hit animation (was 34 -> 28 -> 25 per user requests)
let tossAnimTimer = 0; // counts down from TOSS_ANIM_FRAMES to 0 during 'serve-toss'
let pendingServe = null; // { success, isPower } captured at commit, applied when the anim finishes
const AI_SERVE_TOTAL_DELAY = 49; // must match the aiDelay reset value below (was 65 -> 54 -> 49 per user requests)

let shotLabel = null;
function spawnShotLabel(text, color, x, y) { shotLabel = { text, color, x, y, timer: 32 }; }

// A third, even earlier unlock path — fires on the very first pointer
// press anywhere on the page (before click, before any canvas hit-testing
// even runs), so audio has the best possible chance of being unlocked by
// the time the first hit sound needs to play.
window.addEventListener('pointerdown', unlockAudio, { once: true });

const keys = {};
window.addEventListener('keydown', e => {
  if (['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyX','KeyZ','KeyV'].includes(e.code)) e.preventDefault();
  unlockAudio();

  if (showControls) {
    // Any of these closes it; anything else is just swallowed so it can't
    // leak through to whatever's underneath (e.g. Digit1 starting a mode
    // while the panel is open over the title screen).
    if (['Escape', 'Space', 'KeyC'].includes(e.code)) showControls = false;
    return;
  }

  if (e.code === 'Escape') {
    if (paused) { paused = false; return; }
    // Only a live match (not a menu screen) can be paused; on a menu
    // screen Escape falls through to whatever that screen already does
    // with it (e.g. bailing out of the tournament from the eliminated
    // screen), unaffected by pause at all.
    if (!FROZEN_STATES.includes(gState)) { paused = true; return; }
  }
  if (paused) {
    if (e.code === 'KeyC') showControls = true;
    if (e.code === 'KeyQ') exitTournamentToTitle();
    return; // swallow every other input while paused
  }

  if (gState === 'title') {
    if (e.code === 'Digit1') enterExhibition();
    if (e.code === 'Digit2') startTournament();
    if (e.code === 'KeyC') showControls = true;
    return;
  }
  if (gState === 'tournament-intro') {
    if (e.code === 'Space') beginTournamentRound();
    return;
  }
  if (gState === 'tournament-round-win') {
    if (e.code === 'Space') advanceAfterRoundWin();
    return;
  }
  if (gState === 'tournament-eliminated') {
    if (e.code === 'Space') gState = 'tournament-intro'; // retry the same round
    if (e.code === 'Escape') exitTournamentToTitle();
    return;
  }
  if (gState === 'tournament-champion') {
    if (e.code === 'Space') exitTournamentToTitle();
    return;
  }
  if (gState === 'loadout-select') {
    const lidx = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 }[e.code];
    if (lidx !== undefined) selectLoadout(LOADOUT_ORDER[lidx]);
    return;
  }
  if (gState === 'court-select') {
    const idx = { Digit1: 0, Digit2: 1, Digit3: 2 }[e.code];
    if (idx !== undefined) selectCourt(COURT_ORDER[idx]);
    return;
  }
  if (e.code === 'Space' && gState === 'serving' && currentServer === 'player' && !keys['Space']) {
    attemptPlayerServe();
  }
  // While the one-shot toss animation is playing, ignore further Space
  // presses entirely — the serve is already committed and can't be
  // re-triggered or skipped.
  keys[e.code] = true;
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

// ── COURT SELECT SCREEN ─────────────────────────────────────────────
const COURT_ORDER = ['clay', 'grass', 'hard'];
let courtCardRects = []; // populated each draw so click handling can hit-test
let loadoutCardRects = []; // same idea, for the loadout-select screen's cards
let modeCardRects = [];  // same idea, for the title screen's mode cards
let controlsButtonRect = null; // the title screen's CONTROLS button
let pauseControlsRect = null;  // the pause overlay's CONTROLS button
let pauseQuitRect = null;      // the pause overlay's QUIT TO MENU button

function selectLoadout(key) {
  if (gState !== 'loadout-select') return;
  currentLoadout = key;
  gState = loadoutNextState;
}

function selectCourt(courtKey) {
  if (gState !== 'court-select') return;
  applyCourt(courtKey);
  document.body.classList.remove('pre-match');
  updateHud();
  beginPoint();
}

function hitRect(r, mx, my) { return r && mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h; }

// Live canvas-space mouse position, tracked purely for hover feedback on
// the menu select screens (loadout/court cards) — -1,-1 means "not over
// the canvas," so hitRect() against it never matches any real card.
let mouseX = -1, mouseY = -1;
cv.addEventListener('mousemove', e => {
  const rect = cv.getBoundingClientRect();
  const scaleX = cv.width / rect.width, scaleY = cv.height / rect.height;
  mouseX = (e.clientX - rect.left) * scaleX;
  mouseY = (e.clientY - rect.top) * scaleY;
});
cv.addEventListener('mouseleave', () => { mouseX = -1; mouseY = -1; });

cv.addEventListener('click', e => {
  unlockAudio();
  const rect = cv.getBoundingClientRect();
  const scaleX = cv.width / rect.width, scaleY = cv.height / rect.height;
  const mx = (e.clientX - rect.left) * scaleX, my = (e.clientY - rect.top) * scaleY;

  if (showControls) { showControls = false; return; }

  if (paused) {
    if (hitRect(pauseControlsRect, mx, my)) showControls = true;
    else if (hitRect(pauseQuitRect, mx, my)) exitTournamentToTitle();
    return;
  }

  if (gState === 'title') {
    if (hitRect(controlsButtonRect, mx, my)) { showControls = true; return; }
    for (const card of modeCardRects) {
      if (mx >= card.x && mx <= card.x + card.w && my >= card.y && my <= card.y + card.h) {
        if (card.key === 'exhibition') enterExhibition(); else startTournament();
        break;
      }
    }
    return;
  }
  if (gState === 'tournament-intro') { beginTournamentRound(); return; }
  if (gState === 'tournament-round-win') { advanceAfterRoundWin(); return; }
  if (gState === 'tournament-eliminated') { gState = 'tournament-intro'; return; }
  if (gState === 'tournament-champion') { exitTournamentToTitle(); return; }

  if (gState === 'loadout-select') {
    for (const card of loadoutCardRects) {
      if (mx >= card.x && mx <= card.x + card.w && my >= card.y && my <= card.y + card.h) {
        selectLoadout(card.key);
        break;
      }
    }
    return;
  }

  if (gState !== 'court-select') return;
  for (const card of courtCardRects) {
    if (mx >= card.x && mx <= card.x + card.w && my >= card.y && my <= card.y + card.h) {
      selectCourt(card.key);
      break;
    }
  }
});

// ── TOURNAMENT MODE ─────────────────────────────────────────────────
// A 4-round single-elimination bracket: beat all 4 opponents in a row to
// become champion, lose any match and you're eliminated (retry that same
// round, or bail to the title screen). Difficulty ramps steeply round to
// round — DINK is a genuinely easy opener, ACE is the exhibition-mode
// default's numbers (the "hard" the player was used to) — and each
// opponent is a real distinct playstyle, not just a flat speed bump:
// footspeed, ball-tracking reach, serve threat, shot-type mix, and how
// eagerly they come to net are all tuned separately per opponent.
const TOURNAMENT_OPPONENTS = [
  { name: 'DINK', round: 'Round of 16', style: 'Slow, safe pusher — rarely goes for power',
    speedMult: 0.62, serveSuccess: 0.55, servePowerChance: 0.05,
    reachBase: 3, reachPerSpeed: 1.1,
    shotPowerChance: 0.04, shotSliceChance: 0.10, netLobChance: 0.10, dropShotChance: 0.03,
    netMinRally: 999, netStreakNeeded: 99, netCommitChance: 0, netReadyApproach: 0.62 },
  { name: 'RALLY', round: 'Quarterfinal', style: 'Steady baseline grinder — outlasts, rarely attacks',
    speedMult: 0.82, serveSuccess: 0.70, servePowerChance: 0.16,
    reachBase: 5, reachPerSpeed: 1.7,
    shotPowerChance: 0.10, shotSliceChance: 0.20, netLobChance: 0.20, dropShotChance: 0.08,
    netMinRally: 20, netStreakNeeded: 6, netCommitChance: 0.06, netReadyApproach: 0.68 },
  { name: 'BLAZE', round: 'Semifinal', style: 'Big pace off serve and groundstrokes, goes for winners',
    speedMult: 1.0, serveSuccess: 0.78, servePowerChance: 0.42,
    reachBase: 6, reachPerSpeed: 2.2,
    shotPowerChance: 0.40, shotSliceChance: 0.10, netLobChance: 0.25, dropShotChance: 0.05,
    netMinRally: 16, netStreakNeeded: 4, netCommitChance: 0.14, netReadyApproach: 0.60 },
  { name: 'ACE', round: 'Final', style: 'Complete all-courter — serves big, volleys behind it',
    speedMult: 1.16, serveSuccess: 0.85, servePowerChance: 0.40,
    reachBase: 8, reachPerSpeed: 2.6,
    shotPowerChance: 0.22, shotSliceChance: 0.26, netLobChance: 0.30, dropShotChance: 0.16,
    netMinRally: 8, netStreakNeeded: 2, netCommitChance: 0.35, netReadyApproach: 0.55 },
];

let opponentName = 'ACE';
let opponentSpeedMult = 1;
// round is an index into TOURNAMENT_OPPONENTS — the opponent still to be
// played (or, once it reaches TOURNAMENT_OPPONENTS.length, "champion").
const tournament = { active: false, round: 0 };

function updateOpponentLabel() {
  const el = document.getElementById('opp-name');
  if (el) el.textContent = opponentName;
}
function resetOpponent() {
  opponentName = 'ACE';
  opponentSpeedMult = 1;
  AI_SERVE_SUCCESS = BASE_AI_SERVE_SUCCESS;
  AI_SERVE_POWER_CHANCE = BASE_AI_SERVE_POWER_CHANCE;
  AI_REACH_BASE = BASE_AI_REACH_BASE;
  AI_REACH_PER_SPEED = BASE_AI_REACH_PER_SPEED;
  AI_SHOT_POWER_CHANCE = BASE_AI_SHOT_POWER_CHANCE;
  AI_SHOT_SLICE_CHANCE = BASE_AI_SHOT_SLICE_CHANCE;
  AI_NET_LOB_CHANCE = BASE_AI_NET_LOB_CHANCE;
  AI_DROP_SHOT_CHANCE = BASE_AI_DROP_SHOT_CHANCE;
  AI_MIN_RALLY_BEFORE_NET_RUSH = BASE_AI_MIN_RALLY_BEFORE_NET_RUSH;
  AI_ATTACK_STREAK_NEEDED = BASE_AI_ATTACK_STREAK_NEEDED;
  AI_ATTACK_COMMIT_CHANCE = BASE_AI_ATTACK_COMMIT_CHANCE;
  AI_READY_APPROACH = BASE_AI_READY_APPROACH;
  updateOpponentLabel();
}
function applyOpponent(idx) {
  const o = TOURNAMENT_OPPONENTS[idx];
  opponentName = o.name;
  opponentSpeedMult = o.speedMult;
  AI_SERVE_SUCCESS = o.serveSuccess;
  AI_SERVE_POWER_CHANCE = o.servePowerChance;
  AI_REACH_BASE = o.reachBase;
  AI_REACH_PER_SPEED = o.reachPerSpeed;
  AI_SHOT_POWER_CHANCE = o.shotPowerChance;
  AI_SHOT_SLICE_CHANCE = o.shotSliceChance;
  AI_NET_LOB_CHANCE = o.netLobChance;
  AI_DROP_SHOT_CHANCE = o.dropShotChance;
  AI_MIN_RALLY_BEFORE_NET_RUSH = o.netMinRally;
  AI_ATTACK_STREAK_NEEDED = o.netStreakNeeded;
  AI_ATTACK_COMMIT_CHANCE = o.netCommitChance;
  AI_READY_APPROACH = o.netReadyApproach;
  updateOpponentLabel();
}

// Zeroes both sides' points and games for a fresh match (a new exhibition
// session or one tournament round) — position/serve state is separately
// handled by resetServe()/beginPoint() once a court is chosen.
function resetMatchState() {
  player.pts = 0; ai.pts = 0; player.games = 0; ai.games = 0;
  currentServer = 'player';
  stakesLabel = null;
  pointStreak = { who: null, count: 0 };
  updateHud();
}

// Each tournament round is a best-of-3 match — first to win 2 games takes
// the round, so it's over in 2 or 3 games, never more. The game otherwise
// has no match-end condition at all (exhibition games just accumulate
// indefinitely), so this only applies while a tournament is on.
const ROUND_GAMES_TO_WIN = 2;
function checkMatchWin() {
  if (player.games >= ROUND_GAMES_TO_WIN) return 'player';
  if (ai.games >= ROUND_GAMES_TO_WIN) return 'ai';
  return null;
}

// Where selectLoadout() sends the player once they've picked a racket —
// set right before entering 'loadout-select' so the same screen can serve
// both entry points (exhibition goes straight to court-select; tournament
// goes to its intro/bracket screen first).
let loadoutNextState = 'court-select';

function enterExhibition() {
  tournament.active = false;
  resetOpponent();
  resetMatchState();
  loadoutNextState = 'court-select';
  gState = 'loadout-select';
}
function startTournament() {
  tournament.active = true;
  tournament.round = 0;
  loadoutNextState = 'tournament-intro';
  gState = 'loadout-select';
}
function beginTournamentRound() {
  applyOpponent(tournament.round);
  resetMatchState();
  gState = 'court-select';
}
function handleTournamentMatchEnd(winner) {
  if (winner === 'player') {
    tournament.round++;
    gState = 'tournament-round-win';
  } else {
    gState = 'tournament-eliminated';
  }
}
function advanceAfterRoundWin() {
  gState = tournament.round >= TOURNAMENT_OPPONENTS.length ? 'tournament-champion' : 'tournament-intro';
}
// Also doubles as the general "abandon whatever's in progress and go back
// to the title screen" handler — e.g. quitting from the pause menu during
// an exhibition match. tournament.active=false is simply a no-op there.
function exitTournamentToTitle() {
  tournament.active = false;
  resetOpponent();
  resetMatchState();
  paused = false; // never leave the pause overlay engaged on top of the title screen
  gState = 'title';
}

// ── SCORING ──────────────────────────────────────────────────────────
function ptLabel(mine, theirs) {
  if (mine >= 3 && theirs >= 3) { if (mine === theirs) return 'DEUCE'; return mine > theirs ? 'AD' : '40'; }
  return ['0','15','30','40'][Math.min(mine, 3)];
}
function updateHud() {
  document.getElementById('ps').textContent = ptLabel(player.pts, ai.pts);
  document.getElementById('as').textContent = ptLabel(ai.pts, player.pts);
  document.getElementById('pg').textContent = player.games;
  document.getElementById('ag').textContent = ai.games;
}
function checkGameWin() {
  if (player.pts >= 4 && player.pts - ai.pts >= 2) return 'player';
  if (ai.pts >= 4 && ai.pts - player.pts >= 2) return 'ai';
  return null;
}

// ── MOMENTUM / STAKES PRESENTATION ──────────────────────────────────
// A single top-of-court banner (drawTopBanner()) shows whichever of these
// is more important right now: break/game/match point takes priority (set
// fresh at the start of every point by computeStakes(), called from
// beginPoint()), falling back to a win-streak callout once a side has
// strung together several points in a row. Both are read by awardPoint()
// to size how big a roar the crowd gives a point (see playCrowdCheer()).
let stakesLabel = null;
let pointStreak = { who: null, count: 0 };

// Figures out whether the point about to be played is a break/game/match
// point, by simulating "what if this side wins the next point" against the
// real scoring rules (checkGameWin()'s thresholds, and — in tournament mode
// only, since exhibition has no match-end condition — ROUND_GAMES_TO_WIN).
function computeStakes() {
  const wouldWinGame = (who) => {
    const p = who === 'player' ? player.pts + 1 : player.pts;
    const a = who === 'ai' ? ai.pts + 1 : ai.pts;
    return who === 'player' ? (p >= 4 && p - a >= 2) : (a >= 4 && a - p >= 2);
  };
  const playerGamePt = wouldWinGame('player');
  const aiGamePt = wouldWinGame('ai');
  if (!playerGamePt && !aiGamePt) return null;

  const wouldWinMatch = (who) => {
    if (!tournament.active) return false;
    const games = (who === 'player' ? player.games : ai.games) + 1;
    return games >= ROUND_GAMES_TO_WIN;
  };
  if (playerGamePt && wouldWinMatch('player')) return { text: 'MATCH POINT', color: '#4ab8f0' };
  if (aiGamePt && wouldWinMatch('ai')) return { text: `${opponentName} MATCH POINT`, color: '#f07070' };

  // Break point: the RETURNER (not the server) would win the game.
  if (playerGamePt && currentServer === 'ai') return { text: 'BREAK POINT', color: '#4ab8f0' };
  if (aiGamePt && currentServer === 'player') return { text: `${opponentName} BREAK POINT`, color: '#f07070' };

  if (playerGamePt) return { text: 'GAME POINT', color: '#4ab8f0' };
  return { text: `${opponentName} GAME POINT`, color: '#f07070' };
}

function topBannerInfo() {
  if (stakesLabel) return stakesLabel;
  if (pointStreak.count >= 3) {
    const name = pointStreak.who === 'player' ? 'YOU' : opponentName;
    const color = pointStreak.who === 'player' ? '#4ab8f0' : '#f07070';
    return { text: `${name} — ${pointStreak.count} IN A ROW`, color };
  }
  return null;
}

function awardPoint(who, reason) {
  const winner = who === 'player' ? player : ai;
  winner.pts++;
  ptWin = who; pointReason = reason;
  const gw = checkGameWin();
  gameOverPending = !!gw;
  gState = 'point-end';
  endTimer = reason === 'double-fault' ? 110 : 95;
  updateHud();

  // stakesLabel still holds whatever computeStakes() decided when THIS
  // point began (it isn't recomputed until the next beginPoint()), so this
  // check correctly reflects whether the point that just ended was a big
  // one — used both for the crowd's reaction and to keep/extend the streak.
  const wasBigPoint = !!stakesLabel;
  if (pointStreak.who === who) pointStreak.count++;
  else { pointStreak.who = who; pointStreak.count = 1; }
  const longStreak = pointStreak.count >= 3;
  const intensity = gw ? (wasBigPoint ? 1 : 0.7) : (wasBigPoint ? 0.75 : longStreak ? 0.5 : 0.3);
  playCrowdCheer(intensity);
}

// ── SERVE FLOW ───────────────────────────────────────────────────────
function beginPoint() {
  faultCount = 0;
  stakesLabel = computeStakes();
  const total = player.pts + ai.pts;
  const deuceCourt = total % 2 === 0;
  serverSide = currentServer === 'player' ? (deuceCourt ? 'right' : 'left') : (deuceCourt ? 'left' : 'right');
  targetSide = serverSide === 'right' ? 'left' : 'right';
  resetServe();
}

function resetServe() {
  gState = 'serving';
  rally = 0;
  ball.dx = 0; ball.dy = 0; ball.spin = 0; ball.shotType = 'regular'; ball.isLob = false; ball.isDrop = false;
  ball.lastPlayerNetCloseness = 0; // fresh point — don't let a prior point's net shot linger and shrink the AI's reach on an unrelated rally
  shotLabel = null;
  missType = null;

  // Snap BOTH players back to their true baseline at the start of every
  // point — whoever rushed the net (or retreated deep) last point doesn't
  // carry that position into the next one. They're free to roam again as
  // soon as the point is live; this only resets the starting spot.
  //
  // Both server AND returner now start at the true baseline (not a
  // shallower "ready stance"). A returner standing partway up the court by
  // default made every return of serve start almost inside net-rush range,
  // which — combined with the net proximity speed bonus — produced
  // unrealistically fast, nearly unreturnable returns before the returner
  // had actually chosen to press forward. Starting everyone deep, plus the
  // slower net-approach footspeed below, means reaching the net (and its
  // speed bonus) now takes a real, deliberate push up the court.
  player.y = playerYBounds().hi;
  ai.y = aiYBounds().lo;
  player.hasHit = false; ai.hasHit = false; ai.attackStreak = 0; ai.committedToNet = false; ai.hitsThisPoint = 0; // fresh point — no shot to judge recovery from yet, net lockout re-armed
  player.walkAmount = 0; ai.walkAmount = 0; // stand cleanly at the service stance, no leftover mid-stride leg swing from the last point

  if (currentServer === 'player') {
    // Player no longer shuffles left/right to choose a stance — arrow/WASD
    // now steers the aim crosshair instead — so snap them to a sensible
    // spot behind their serve-side half automatically.
    player.x = Math.max(CL, Math.min(CR - player.w, centerOfHalf(serverSide) - player.w/2));
    ai.x = Math.max(CL, Math.min(CR - ai.w, centerOfHalf(targetSide) - ai.w/2));
    document.getElementById('hint').textContent = 'AIM & TIME YOUR SERVE';
    aiDelay = 0;
  } else {
    ai.x = Math.max(CL, Math.min(CR - ai.w, centerOfHalf(serverSide) - ai.w/2));
    player.x = Math.max(CL, Math.min(CR - player.w, centerOfHalf(targetSide) - player.w/2));
    document.getElementById('hint').textContent = `${opponentName} SERVING...`;
    aiDelay = AI_SERVE_TOTAL_DELAY;
  }
  // Fresh timing-bar zone center + power-window offset for this point. The
  // WIDTH of both is recomputed live from aim position (recomputeServeZones)
  // so moving the crosshair immediately changes difficulty.
  zoneCenter = ZONE_WIDTH/2 + Math.random() * (1 - ZONE_WIDTH);
  powerCenterOffset = Math.random() * (1 - POWER_WINDOW_WIDTH/ZONE_WIDTH - POWER_WINDOW_WIDTH/ZONE_WIDTH) + POWER_WINDOW_WIDTH/ZONE_WIDTH;
  powerCenterOffset = Math.max(0.1, Math.min(0.9, powerCenterOffset));
  aimX = 0.5; aimY = 0.5; // start each serve dead-center; player/AI steers from there
  recomputeServeZones();
  serveBarPos = 0; serveBarDir = 1;
  tossAnimTimer = 0;
  pendingServe = null;
  if (currentServer === 'ai') pickAiAim();
}

// Gives the AI its own aim point each service so its difficulty factor and
// speed bonus are computed identically to the player's. Weighted so the AI
// usually plays a moderate placement but occasionally goes for a corner.
function pickAiAim() {
  const goForCorner = Math.random() < 0.35;
  if (goForCorner) {
    aimX = Math.random() < 0.5 ? 0.08 + Math.random()*0.12 : 0.8 + Math.random()*0.12;
    aimY = Math.random() < 0.5 ? 0.08 + Math.random()*0.12 : 0.8 + Math.random()*0.12;
  } else {
    aimX = 0.35 + Math.random() * 0.3;
    aimY = 0.35 + Math.random() * 0.3;
  }
  recomputeServeZones();
}

function attemptPlayerServe() {
  const inZone  = serveBarPos >= zoneStart && serveBarPos <= zoneEnd;
  const inPower = serveBarPos >= powerStart && serveBarPos <= powerEnd;
  commitServe(inZone, inPower);
}

// Called the instant a serve is committed — by the player's Space press
// (using the exact serveBarPos zone/power check, unchanged) or by the AI's
// aiDelay countdown expiring. Success/power is decided right here, exactly
// as it always was; only the ball's actual launch is deferred until the
// one-shot toss-and-hit animation finishes playing.
function commitServe(success, isPower) {
  pendingServe = { success, isPower };
  tossAnimTimer = TOSS_ANIM_FRAMES;
  gState = 'serve-toss';
  document.getElementById('hint').textContent = '';
}

// A missed serve fails in one of three realistic ways instead of always
// sailing over the net into roughly the same spot: it can die in the net,
// sail long past the far baseline, or land wide — and a wide miss now only
// drifts a little past the box edge rather than clear across the court.
const MISS_TYPES = ['net', 'long', 'wide'];
const MISS_WEIGHTS = [0.30, 0.30, 0.40];
function pickMissType() {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < MISS_TYPES.length; i++) {
    acc += MISS_WEIGHTS[i];
    if (r < acc) return MISS_TYPES[i];
  }
  return MISS_TYPES[MISS_TYPES.length - 1];
}

function launchServe(success, isPower) {
  const startX = currentServer === 'player' ? player.x + player.w/2 : ai.x + ai.w/2;
  const startY = currentServer === 'player' ? player.y - ball.r - 2 : ai.y + ai.h + ball.r + 2;
  const lineY  = currentServer === 'player' ? svcT : svcB;
  const end    = currentServer === 'player' ? 'top' : 'bottom';
  const farBaseline = currentServer === 'player' ? CT : CB; // the far baseline, past the service box

  const power = success && isPower;
  const diff = success ? aimDifficulty(aimX, aimY) : 0;
  ball.serveDifficulty = diff; // read by servePlacementReachMult() during the return
  // Corner/edge placements pay off with extra pace, stacking with the
  // existing power-window bonus — genuine risk/reward for a tougher target.
  const speedBonus = 1 + diff * AIM_SPEED_BONUS_MAX;
  // The Power loadout's powerMult only boosts the PLAYER's own power serve
  // — never the AI's — matching how it only touches the player's power
  // shots in doBounce() too.
  const loadoutServeMult = (currentServer === 'player' && power) ? LOADOUTS[currentLoadout].powerMult : 1;
  const baseSpd = (power ? SERVE_SPEED_POWER : SERVE_SPEED) * speedBonus * loadoutServeMult;

  let targetX, targetY, spd = baseSpd;
  missType = null;

  if (success) {
    const box = boxRect(end, targetSide);
    // Land it exactly where the aim crosshair was placed — both across
    // (aimX) and in depth within the box (aimY) — clamped a little inside
    // the box edges so it can't be aimed dead on a line.
    targetX = box.x + box.w * Math.max(0.06, Math.min(0.94, aimX));
    targetY = box.y + box.h * Math.max(0.06, Math.min(0.94, aimY));
  } else {
    missType = pickMissType();
    const box = boxRect(end, targetSide); // still aim roughly at the intended box, just fail to land in it
    if (missType === 'net') {
      // Dies right at the net — doesn't have the pace/arc to clear it.
      targetX = box.x + box.w * (0.15 + Math.random() * 0.7);
      targetY = NET_Y + (currentServer === 'player' ? 6 : -6);
      spd = baseSpd * (0.45 + Math.random() * 0.2);
    } else if (missType === 'long') {
      // Clears the service line entirely and sails past the far baseline.
      targetX = box.x + box.w * (0.15 + Math.random() * 0.7);
      targetY = farBaseline + (currentServer === 'player' ? -1 : 1) * (14 + Math.random() * 22);
      spd = baseSpd * (1.05 + Math.random() * 0.25);
    } else {
      // Wide — lands past the box's left/right edge, but only just past it,
      // not clear across the court. Picks whichever edge is closer to the
      // current aim so it still reads as a near-miss, not a random flail.
      const missLeft = Math.random() < 0.5;
      const edgeX = missLeft ? box.x : box.x + box.w;
      const overshoot = 8 + Math.random() * 26; // how far past the sideline it drifts
      targetX = missLeft ? edgeX - overshoot : edgeX + overshoot;
      targetY = box.y + box.h * (0.25 + Math.random() * 0.5);
    }
  }

  const ddx = targetX - startX, ddy = targetY - startY;
  const dist = Math.hypot(ddx, ddy) || 1;
  ball.dx = ddx/dist*spd; ball.dy = ddy/dist*spd;
  clampBallSpeed();
  ball.x = startX; ball.y = startY;
  ball.shotType = power ? 'power' : 'regular';

  serveLineY = missType === 'net' ? NET_Y : (missType === 'long' ? farBaseline : lineY);
  servePrevSide = Math.sign(serveLineY - startY);
  gState = 'serve-flight';
  document.getElementById('hint').textContent = '';

  // The serve itself is a swing — trigger the racket animation for whoever
  // is serving, using the toss position as the contact point.
  const server = currentServer === 'player' ? player : ai;
  server.hitTimer = STRIKE_FRAMES;
  server.contactX = startX; server.contactY = startY;
  server.lastShotType = power ? 'power' : 'regular';
  server.flashAlpha = power ? 1.0 : 0.6;
  playHitSound(power ? 1.0 : 0.5);

  if (power) spawnShotLabel('POWER SERVE!', '#ff9450', startX, startY - 6);
}

function resolveServeLanding() {
  if (missType === 'net' || missType === 'long' || missType === 'wide') {
    // These three all fail by construction — the trajectory was aimed at a
    // point outside the box (into the net / past the baseline / past a
    // sideline), so there's no need to re-check ball.x against the box:
    // that check is only meaningful for a serve that was actually aimed
    // AT the box (a real success, or the old undifferentiated miss).
    faultCount++;
    if (faultCount >= 2) awardPoint(currentServer === 'player' ? 'ai' : 'player', 'double-fault');
    else { gState = 'fault-pause'; faultTimer = 60; }
    return;
  }
  const end = currentServer === 'player' ? 'top' : 'bottom';
  const box = boxRect(end, targetSide);
  const inBox = ball.x >= box.x && ball.x <= box.x + box.w;
  if (inBox) { gState = 'playing'; return; }
  faultCount++;
  if (faultCount >= 2) awardPoint(currentServer === 'player' ? 'ai' : 'player', 'double-fault');
  else { gState = 'fault-pause'; faultTimer = 60; }
}

// ── ANTICIPATION (racket pulls back as the ball closes in) ────────────
// NET-RUSH RISK/REWARD, part 1: the closer a pad is playing to the net, the
// less time the ball spends inside its windup/anticipation range before
// arrival, since that range is measured in fixed PIXELS but the pad is
// physically closer to where the ball is coming from. We make this an
// explicit, tunable penalty (not just an incidental side-effect of geometry)
// by shrinking the anticipation window itself as the pad's distance to the
// net shrinks — net play is harder to time cleanly, on top of already
// getting less raw distance/time. Baseline play keeps the full window.
const ANTICIPATION_WINDOW_MAX = 110; // full window at/behind baseline depth
const ANTICIPATION_WINDOW_MIN = 55;  // tightest window right on top of the net
function anticipationWindow(pad, isPlayer) {
  const bounds = isPlayer ? playerYBounds() : aiYBounds();
  const span = (bounds.hi - bounds.lo) || 1;
  // 0 = pad standing right at the net, 1 = pad standing at the baseline.
  const netDist = isPlayer
    ? (pad.y - bounds.lo) / span
    : (bounds.hi - pad.y) / span;
  const t = Math.max(0, Math.min(1, netDist));
  return ANTICIPATION_WINDOW_MIN + t * (ANTICIPATION_WINDOW_MAX - ANTICIPATION_WINDOW_MIN);
}
function updateAnticipation(pad, isPlayer) {
  if (pad.hitTimer > 0) { pad.windup = 0; return; }
  const approaching = isPlayer ? ball.dy > 0 : ball.dy < 0;
  const gap = isPlayer ? (pad.y - ball.y) : (ball.y - (pad.y + pad.h));
  const window = anticipationWindow(pad, isPlayer);
  pad.windup = (approaching && gap > 0 && gap < window) ? (1 - gap/window) : 0;
}

// ── COLLISION (regular rally play) ──────────────────────────────────
// `reachY` extends the pad's hit-detection band vertically (both edges),
// and `reachX` extends it horizontally (both edges) — neither changes the
// pad's visible size on screen, just how forgiving the invisible contact
// check is. Used to give the AI a forgiving interception tolerance (see the
// call site below), and now also a smaller, fixed tolerance for the player.
function overlaps(pad, reachY, reachX) {
  reachY = reachY || 0;
  reachX = reachX || 0;
  return ball.x + ball.r > pad.x - reachX && ball.x - ball.r < pad.x + pad.w + reachX &&
         ball.y + ball.r > pad.y - reachY && ball.y - ball.r < pad.y + pad.h + reachY;
}

// The AI's hitbox is only pad.h (10px) tall, and its movement is a fixed
// per-frame pursuit toward a target — it can't make the kind of last-instant
// reflex adjustment a human player controlling arrow keys can. Once depth
// (not just left-right) is a real axis it has to cover, a fast ball crosses
// that thin band faster than the AI can physically arrive if it starts more
// than a small margin away. This gives the AI a taller EFFECTIVE reach —
// scaled up with the ball's incoming speed, since that's exactly when a
// fixed-speed pursuit AI needs the most help — without changing its visible
// sprite size or how it looks on screen. Purely a fairness/playability
// compensation, not a visual or positional change.
// Mutable (BASE_ = exhibition/default) so each tournament opponent can have
// genuinely different ball-tracking skill — a low-reach opponent visibly
// whiffs returns a fast/well-placed shot, which is a big part of what makes
// an "easy" opponent actually feel easy rather than just a bit slower.
const BASE_AI_REACH_BASE = 6, BASE_AI_REACH_PER_SPEED = 2.2;
let AI_REACH_BASE = BASE_AI_REACH_BASE;     // minimum forgiveness even on a slow ball
let AI_REACH_PER_SPEED = BASE_AI_REACH_PER_SPEED; // extra px of reach per unit of ball speed
// A shot the PLAYER struck from up close at the net shrinks the AI's
// forgiveness on the return — up to a 60% reduction at a full net-rush
// contact (closeness===1), scaling down to no reduction at all once the
// player was at/behind normal ready-stance depth (closeness===0). This is
// the actual "reward" for good net position: the same shot speed as always,
// but the AI's fixed-speed pursuit gets meaningfully less help closing the
// gap on a ball struck from up close, since a real net shot leaves less
// time to react than the AI's baseline reach compensation assumes.
const AI_REACH_NET_PENALTY_MAX = 0.6;
function aiReachY() {
  const base = AI_REACH_BASE + Math.abs(ball.dy) * AI_REACH_PER_SPEED;
  // The net-closeness penalty exists to punish a fast, sharp shot struck
  // from up close — it shouldn't also apply to a lob, which is slow and
  // floaty by design (and already has its own, much harsher counter: it's
  // simply unreturnable if the AI is caught up at net — see
  // isPadUpAtNet()/aiCanPlayBall). Stacking this penalty on top of that was
  // making a lob to an AI that's sitting at the baseline, doing nothing
  // wrong, needlessly hard to track down too.
  const penalty = ball.isLob ? 1 : 1 - ball.lastPlayerNetCloseness * AI_REACH_NET_PENALTY_MAX;
  return base * penalty * servePlacementReachMult();
}

// A small forgiveness for the human player only — the game was feeling too
// hard to connect with reliably, so contact is a little more forgiving on
// both axes without touching the player's visible sprite/racket size.
const PLAYER_REACH_Y = 12;
const PLAYER_REACH_X = 11;
// Speed-scaled component of the player's Y reach, mirroring aiReachY()'s own
// compensation for a fixed-speed pursuit — added because a fast AI shot
// (a power shot, especially one further amplified by the net-proximity bonus
// in doBounce()) was reaching speeds the player's old flat-only reach never
// accounted for, while the AI's own reach automatically grew to match. That
// asymmetry made AI power/net shots feel unreturnable — "overpowered" — even
// though the same shot from the player was never that hard for the AI to
// track down. Deliberately a fraction of AI_REACH_PER_SPEED (below) rather
// than matching it 1:1: the player has real human reflexes via arrow keys,
// so needs less raw compensation than a fixed-speed pursuit AI does to feel
// competitive, just not zero.
const PLAYER_REACH_PER_SPEED = 0.9;
// NET_APPROACH_SPEED_MULT (below, in the net-rushing movement section)
// throttles the player's closing speed toward the net to 55% so instant
// net-rushing isn't free — but that means holding a forward or forward-
// diagonal direction covers noticeably less ground per frame than holding
// a purely sideways one, so contact often isn't there yet by the time the
// ball's flight says it should be, even though the pad visually looks
// aligned. Rather than touch that movement throttle (it's deliberate
// net-rush pacing), give forward movement extra vertical forgiveness on
// the hit-detection side specifically, so advancing on the ball connects
// the way it visually looks like it should.
const PLAYER_FORWARD_REACH_BONUS = 10;
function playerReachY() {
  const movingForward = keys['ArrowUp'] || keys['KeyW'];
  const base = PLAYER_REACH_Y + Math.abs(ball.dy) * PLAYER_REACH_PER_SPEED + (movingForward ? PLAYER_FORWARD_REACH_BONUS : 0);
  return base * servePlacementReachMult() * LOADOUTS[currentLoadout].reachMult;
}
function playerReachX() {
  return PLAYER_REACH_X * servePlacementReachMult() * LOADOUTS[currentLoadout].reachMult;
}
// Mutable (BASE_ = exhibition/default) shot-mix knobs — how often the AI
// goes for a power shot or a slice vs. a plain regular shot, and how often
// it counters a net-rushing player with a lob. Each tournament opponent
// overrides these to read as a distinct playstyle (a grinder barely ever
// powers or slices; a power-hitter goes for it constantly).
const BASE_AI_SHOT_POWER_CHANCE = 0.18, BASE_AI_SHOT_SLICE_CHANCE = 0.16, BASE_AI_NET_LOB_CHANCE = 0.3;
let AI_SHOT_POWER_CHANCE = BASE_AI_SHOT_POWER_CHANCE;
let AI_SHOT_SLICE_CHANCE = BASE_AI_SHOT_SLICE_CHANCE;
let AI_NET_LOB_CHANCE = BASE_AI_NET_LOB_CHANCE;
// Mirrors AI_NET_LOB_CHANCE, but for the opposite situation: the AI plays a
// drop shot when the PLAYER is sitting deep at the baseline instead of
// coming forward — the drop shot's whole point (see doBounce()'s 'drop'
// branch) is punishing exactly that.
const BASE_AI_DROP_SHOT_CHANCE = 0.12;
let AI_DROP_SHOT_CHANCE = BASE_AI_DROP_SHOT_CHANCE;
function decideShotType(isPlayer) {
  if (isPlayer) {
    if (keys['KeyZ']) return 'lob';
    if (keys['ShiftLeft'] || keys['ShiftRight']) return 'power';
    if (keys['KeyX']) return 'slice';
    if (keys['KeyV']) return 'drop';
    return 'regular';
  }
  // The AI throws in a lob specifically when the PLAYER has pushed forward
  // into net-rush range — the same punish the player gets against it,
  // returned in kind, so camping the net isn't a free lunch against the AI
  // either. Kept deliberately infrequent (not "every single opportunity")
  // so it reads as a sharp, occasional counter rather than something the AI
  // spams the instant you're up there — the whole point is it should feel
  // earned/surprising, not like an automatic response to net position.
  const playerBounds = playerYBounds();
  const playerNetDist = (player.y - playerBounds.lo) / ((playerBounds.hi - playerBounds.lo) || 1);
  const playerIsUpAtNet = playerNetDist < (1 - RETURN_READY_DEPTH) * 0.6; // meaningfully past ready depth
  // Meaningfully deeper than the normal ready position (0.72) — genuinely
  // camped at the back, not just standing at a normal rally depth.
  const playerIsDeep = playerNetDist > 0.85;
  if (playerIsUpAtNet && Math.random() < AI_NET_LOB_CHANCE) return 'lob';
  if (playerIsDeep && Math.random() < AI_DROP_SHOT_CHANCE) return 'drop';
  const r = Math.random();
  if (r < AI_SHOT_POWER_CHANCE) return 'power';
  if (r < AI_SHOT_POWER_CHANCE + AI_SHOT_SLICE_CHANCE) return 'slice';
  return 'regular';
}
// NET-RUSH RISK/REWARD, part 2: a shot struck close to the net comes back
// genuinely faster/sharper than the same shot struck from the baseline —
// the payoff for surviving the tighter anticipation window above. Scales
// smoothly from 1.0x at/behind baseline depth up to NET_BONUS_MAX right at
// the net, using the same depth bounds as everything else net-related.
//
// IMPORTANT: the bonus's zero point is NOT the true baseline — it's the
// normal "ready stance" depth (RETURN_READY_DEPTH, 72% of the way back).
// That's where both the server's opponent (returning serve) and a player
// settling into a rally naturally stand by default, without deliberately
// rushing forward. If the bonus ramped up from the true baseline, standing
// in that ordinary ready position would already read as "close to the net"
// and hand out a big chunk of the speed bonus for free on every single
// point — which is exactly what was happening (the AI's return-of-serve
// depth alone was worth ~70% of the max bonus before it ever moved). Now a
// pad has to actually advance PAST its normal ready depth, toward the net,
// to earn any bonus at all — real net-rushing, not just standing normally.
const NET_BONUS_MAX = 1.15;      // speed multiplier for a contact right on the net (was 1.35 — toned down, net play was overpowering rallies)
const NET_BONUS_DX_MAX = 0.5;    // extra angle sharpness at the net (was 1.2 — a sharp net winner shouldn't be nearly uncatchable)
// PLAYER-ONLY placement steering: rather than leaning further on raw speed,
// a player shot struck close to the net gets nudged away from the AI's
// current side of the court — see the isPlayer branch in doBounce(). Kept
// modest (a fraction of the court half-width) so it reads as "placed well,"
// not "impossible to defend no matter where you stand."
const NET_PLACEMENT_STEER_MAX = 1.0;
function netProximityBonus(pad, isPlayer) {
  const bounds = isPlayer ? playerYBounds() : aiYBounds();
  const span = (bounds.hi - bounds.lo) || 1;
  // Use the pad's own standing position (pad.y), NOT the ball's contact
  // point (pad.contactY). The AI's hit-detection band is deliberately
  // extended vertically via aiReachY() so a fixed-speed pursuit AI can
  // plausibly reach fast balls (see overlaps()/aiReachY() above) — but that
  // means the ball's actual contact Y can land well outside where the AI is
  // really standing, especially on a fast return. If the net bonus keyed off
  // that inflated contact point, a deep AI return caught only via reach
  // tolerance could register as if the AI had rushed the net, handing out a
  // large unearned speed bonus. Keying off pad.y ties the bonus to where the
  // pad actually chose to stand, which is what "net-rushing" should mean.
  const netDist = isPlayer
    ? (pad.y - bounds.lo) / span
    : (bounds.hi - pad.y) / span;
  // netDist: 0 at the net, 1 at the true baseline. Remap so 0 bonus covers
  // the whole "at or behind ready stance" range, and bonus only grows once
  // the pad is closer to the net than that.
  const readyNetDist = 1 - RETURN_READY_DEPTH; // ready stance's netDist value
  const advancePastReady = readyNetDist - Math.max(0, Math.min(1, netDist));
  const closeness = Math.max(0, Math.min(1, advancePastReady / readyNetDist));
  return {
    speedMult: 1 + closeness * (NET_BONUS_MAX - 1),
    dxMult: 1 + closeness * NET_BONUS_DX_MAX,
    closeness
  };
}
// LOB — the direct counter to a net-rusher. Since the game is intentionally
// flat 2D with no ball-height/bounce model, height is faked explicitly: the
// lob follows a fixed-duration flight path from the contact point to a deep
// target (near the FAR baseline, not just "somewhere upcourt" — a real lob
// is hit deep specifically so it can't be run down easily), with an eased
// progress curve that climbs slowly and then drops fast at the end — the
// same shape a real lob's gravity arc has — instead of moving at a flat
// speed the whole way. ball.lobHeight (0..1, peaking mid-flight) drives the
// visual arc (see drawBall) so it actually reads as going up and over
// someone, not just "a slow shot." While a pad is caught up in net-rush
// range during the flight, the lob is unreturnable to them — it sails over
// their head no matter where they stand left-right — forcing a real retreat.
const LOB_DURATION_FRAMES = 46;   // total flight time — was 62, sped up so a net-rusher genuinely can't run it down
const LOB_TARGET_DEPTH = 0.88;    // how deep into the FAR court the lob aims (0=net, 1=baseline)
const LOB_EASE_POWER = 1.7;       // >1 = slow climb, accelerating fall (gravity feel)
// A pad counts as "up at net" (and thus lobbable) once it's past this same
// threshold used for the AI's own decision to throw a lob — meaningfully
// forward of the normal ready stance, not just anywhere in the front half.
function isPadUpAtNet(pad, isPlayer) {
  const bounds = isPlayer ? playerYBounds() : aiYBounds();
  const span = (bounds.hi - bounds.lo) || 1;
  const netDist = isPlayer ? (pad.y - bounds.lo) / span : (bounds.hi - pad.y) / span;
  return netDist < (1 - RETURN_READY_DEPTH) * 0.6;
}

// Advances a live lob's flight by one frame using its eased progress curve,
// updating ball.x/y (and ball.dx/dy purely for anything else that reads
// them, e.g. spin/anticipation/racket-swing code) and ball.lobHeight for
// the visual arc. Called from update() INSTEAD OF the normal
// `ball.x += ball.dx; ball.y += ball.dy` integration while a lob is live.
function advanceLob() {
  ball.lobT = Math.min(1, ball.lobT + 1 / ball.lobDuration);
  const t = ball.lobT;
  // Eased progress: starts slow (the "climb"), accelerates toward the end
  // (the "fall") — t^EASE_POWER front-loads time near t=0 and compresses it
  // near t=1, which visually reads as slow-then-fast, matching gravity.
  const eased = Math.pow(t, LOB_EASE_POWER);
  const prevX = ball.x, prevY = ball.y;
  ball.x = ball.lobStartX + (ball.lobTargetX - ball.lobStartX) * eased;
  ball.y = ball.lobStartY + (ball.lobTargetY - ball.lobStartY) * eased;
  ball.dx = ball.x - prevX;
  ball.dy = ball.y - prevY;
  // Height peaks at mid-flight (a simple sine arc over progress, not the
  // eased value — the ARC should look symmetric even though the ball's
  // ground-track speed isn't) and hits 0 at both ends.
  ball.lobHeight = Math.sin(Math.PI * t);
}

// DROP SHOT — the mirror-image counter to the lob above: where a lob
// punishes a net-rusher (unreturnable no matter where they stand once
// caught up close), a drop shot punishes a baseline camper. It uses the
// exact same target-based flight approach as advanceLob() — a start point,
// a fixed target, an eased progress curve — but aimed shallow (right near
// the net) with a much shorter flight time. Reachability is NOT a special
// latch like the lob's: it falls out naturally from DROP_DURATION_FRAMES
// being far too short for a pad starting back at the baseline to physically
// close that much ground (see NET_APPROACH_SPEED_MULT) before the ball dies
// — the same overlaps()/reach checks used for every other shot still apply
// every frame, so a pad that's already up near net can absolutely defend it.
const DROP_DURATION_FRAMES = 22; // short — a deep pad can't run this down in time
const DROP_TARGET_DEPTH = 0.12;  // 0=net, 1=baseline — always lands shallow, near the net
const DROP_EASE_POWER = 0.6;     // <1 = quick off the strings, floats/dies near the target
function advanceDrop() {
  ball.dropT = Math.min(1, ball.dropT + 1 / ball.dropDuration);
  const t = ball.dropT;
  const eased = Math.pow(t, DROP_EASE_POWER);
  const prevX = ball.x, prevY = ball.y;
  ball.x = ball.dropStartX + (ball.dropTargetX - ball.dropStartX) * eased;
  ball.y = ball.dropStartY + (ball.dropTargetY - ball.dropStartY) * eased;
  ball.dx = ball.x - prevX;
  ball.dy = ball.y - prevY;
  // A small, subtle arc — just enough to read as a soft touch shot lifting
  // barely over the net, nowhere near the lob's big height.
  ball.dropHeight = Math.sin(Math.PI * t);
}

function doBounce(pad, isPlayer) {
  // Capture the true contact point BEFORE we snap the ball outside the paddle
  pad.contactX = ball.x; pad.contactY = ball.y;
  pad.hasHit = true;
  if (!isPlayer) pad.hitsThisPoint = (pad.hitsThisPoint || 0) + 1; // counts toward the net-rush lockout in aiYBounds()

  const offset = (ball.x - (pad.x + pad.w/2)) / (pad.w/2);
  const shotType = decideShotType(isPlayer);
  ball.shotType = shotType;
  pad.lastShotType = shotType;
  // A power shot cracks louder/brighter; a lob or drop shot is a soft,
  // muted touch by comparison — the same synthesized hit, just scaled by
  // how hard it was. A drop shot is barely tapped, softer even than a lob.
  playHitSound(shotType === 'power' ? 1.0 : shotType === 'drop' ? 0.15 : shotType === 'lob' ? 0.25 : shotType === 'slice' ? 0.4 : 0.55);

  const contactX = isPlayer ? pad.contactX : pad.contactX;
  const contactY = isPlayer ? pad.y - ball.r - 1 : pad.y + pad.h + ball.r + 1;

  if (shotType === 'lob') {
    // Target-based flight, not a flat dy — see advanceLob(). Aim deep into
    // the FAR court (near the opponent's own baseline) so it can't just be
    // let bounce and casually run down; a real lob is hit for depth
    // specifically. X target keeps a damped version of the paddle-offset
    // steering so it's not perfectly straight, but doesn't fly as wide as a
    // normal groundstroke would.
    const targetBounds = isPlayer ? aiYBounds() : playerYBounds();
    const targetSpan = targetBounds.hi - targetBounds.lo;
    // depth 0 = at the opponent's net edge, 1 = at the opponent's baseline
    const landDepth = isPlayer ? (1 - LOB_TARGET_DEPTH) : LOB_TARGET_DEPTH;
    ball.lobStartX = contactX; ball.lobStartY = contactY;
    ball.lobTargetY = targetBounds.lo + landDepth * targetSpan;
    ball.lobTargetX = Math.max(CL + ball.r, Math.min(CR - ball.r, contactX + offset * 70));
    ball.lobT = 0;
    ball.lobDuration = LOB_DURATION_FRAMES;
    ball.lobHeight = 0;
    ball.lobCaughtPlayer = false;
    ball.lobCaughtAi = false;
    ball.x = contactX; ball.y = contactY;
    ball.dx = 0; ball.dy = isPlayer ? -0.01 : 0.01; // just enough to satisfy the dy-sign collision gating below
    ball.spin = 0;
  } else if (shotType === 'drop') {
    // See advanceDrop()'s comment for the design — target-based flight,
    // always landing shallow (near the net) on the OPPONENT's side, using
    // the same lo/hi-orientation flip the lob uses to convert a "0=net,
    // 1=baseline" depth into whichever bounds object applies.
    // isPlayer passes `true` (ignoreNetLockout) to aiYBounds() — the
    // AI's attack-eligibility lockout shrinks its net-side bound early in
    // a rally for a reason that has nothing to do with how close a drop
    // shot lands (see aiYBounds()'s comment); using the locked bound here
    // made "88% of the way to net" land only 88% of the way to the
    // service line instead — genuinely deep in the backcourt, not a drop
    // shot at all. moveAI()'s matching chase exemption is what actually
    // gives the AI a fair shot at reaching this now-consistently-shallow
    // target instead of making it unreturnable by construction.
    const targetBounds = isPlayer ? aiYBounds(true) : playerYBounds();
    const targetSpan = targetBounds.hi - targetBounds.lo;
    const landDepth = isPlayer ? (1 - DROP_TARGET_DEPTH) : DROP_TARGET_DEPTH;
    ball.dropStartX = contactX; ball.dropStartY = contactY;
    ball.dropTargetY = targetBounds.lo + landDepth * targetSpan;
    ball.dropTargetX = Math.max(CL + ball.r, Math.min(CR - ball.r, contactX + offset * 40));
    ball.dropT = 0;
    ball.dropDuration = DROP_DURATION_FRAMES;
    ball.dropHeight = 0;
    ball.x = contactX; ball.y = contactY;
    ball.dx = 0; ball.dy = isPlayer ? -0.01 : 0.01;
    ball.spin = 0;
  } else {
    const netBonus = netProximityBonus(pad, isPlayer);
    let dyMag;
    if (shotType === 'power') {
      // Always a fixed, strong speed — guaranteed faster than any regular
      // rally speed can reach (MAX_SPD caps regular shots at 12). Clamp to
      // MAX_SPD_POWER FIRST, then apply the net bonus on top — the old code
      // scaled the cap itself by the bonus (Math.min(x*bonus, cap*bonus)),
      // which isn't a cap at all since the ceiling moves with the value.
      dyMag = Math.min(ball.speed * POWER_MULT, MAX_SPD_POWER) * netBonus.speedMult;
      // Power loadout only boosts the PLAYER's own power shots, never the
      // AI's — this is purely the human's equipment choice.
      if (isPlayer) dyMag *= LOADOUTS[currentLoadout].powerMult;
    } else {
      dyMag = Math.min((Math.abs(ball.dy) || ball.speed) * 1.05, MAX_SPD) * netBonus.speedMult;
    }
    ball.dy = isPlayer ? -dyMag : dyMag;
    ball.dx = offset * ball.speed * 1.15 * netBonus.dxMult;

    if (isPlayer) {
      // Track how close the player was to the net on THIS shot so aiReachY()
      // can shrink the AI's forgiveness on the return (see AI_REACH_NET_PENALTY_MAX
      // above) — this is what actually makes net position pay off, rather
      // than just adding more raw speed.
      ball.lastPlayerNetCloseness = netBonus.closeness;
      // PLACEMENT bonus: a player shot struck near the net gets steered
      // away from wherever the AI is CURRENTLY standing, on top of the
      // normal paddle-offset angle — "read the defender and go around them"
      // instead of just "hit it harder." Zero effect at/behind ready
      // stance (closeness 0); at a full net-rush contact, up to
      // NET_PLACEMENT_STEER_MAX of the court's half-width gets added away
      // from the AI's side. Only nudges AWAY from the AI, never adds pure
      // randomness, so it still reads as skillful rather than lucky.
      const courtCenterX = (CL + CR) / 2;
      const aiCenterX = ai.x + ai.w / 2;
      const aiSide = aiCenterX >= courtCenterX ? -1 : 1; // steer toward the side the AI ISN'T on
      const halfWidth = (CR - CL) / 2;
      ball.dx += aiSide * netBonus.closeness * NET_PLACEMENT_STEER_MAX * halfWidth * 0.05;
    } else {
      // The AI just returned the player's shot (whether or not that return
      // was helped by the reach penalty) — clear it so the penalty doesn't
      // linger and shrink the AI's reach again on a LATER exchange that has
      // nothing to do with the player's original net position.
      ball.lastPlayerNetCloseness = 0;
    }
    clampBallSpeed(); // absolute ceiling on the resultant speed, see BALL_MAX_SPEED above

    if (shotType === 'slice') {
      // Curve direction follows which side of the paddle you hit, but the
      // MAGNITUDE has a floor — otherwise a near-dead-center hit produces
      // almost no visible bend and slice looks like it "isn't working."
      const dir = offset >= 0 ? 1 : -1;
      const strength = Math.max(Math.abs(offset), SLICE_MIN_OFFSET);
      // Spin loadout only sharpens the PLAYER's own slice curve.
      const spinLoadoutMult = isPlayer ? LOADOUTS[currentLoadout].spinMult : 1;
      ball.spin = dir * strength * SLICE_CURVE * spinLoadoutMult;
    } else {
      ball.spin = 0;
    }
    ball.y = contactY;
    if (netBonus.closeness > 0.55 && shotType === 'regular') {
      // A clean net-rush contact on an otherwise "regular" shot deserves its
      // own callout, since the speed/angle bonus is real but shotType stayed
      // 'regular' (power/slice already show their own label above).
      spawnShotLabel('NET!', '#f0e850', ball.x, ball.y);
    }
  }

  // Mark the ball as a live lob/drop so the collision code (below) can skip
  // the opponent's hitbox for the rest of a lob's flight the moment they're
  // caught up in net-rush range — see ball.lobCaughtPlayer/lobCaughtAi. A
  // drop shot carries no such latch (see advanceDrop()'s comment).
  ball.isLob = shotType === 'lob';
  ball.isDrop = shotType === 'drop';

  pad.hitTimer = STRIKE_FRAMES;
  pad.flashAlpha = shotType === 'power' ? 1.0 : shotType === 'lob' ? 0.85 : shotType === 'drop' ? 0.5 : 0.75;
  if (shotType === 'lob') {
    spawnShotLabel('LOB!', '#b98cff', ball.x, ball.y);
  } else if (shotType === 'drop') {
    spawnShotLabel('DROP SHOT!', '#f0d060', ball.x, ball.y);
  } else if (shotType !== 'regular') {
    spawnShotLabel(shotType === 'power' ? 'POWER!' : 'SLICE!',
      shotType === 'power' ? '#ff9450' : '#5adcb4', ball.x, ball.y);
  }
  rally++;
}

// ── MOVEMENT ─────────────────────────────────────────────────────────
// Full 2D movement: arrow/WASD now moves the player anywhere within their
// own half (side to side AND toward/away from the net), not just left and
// right along a fixed baseline row. (During 'serving'/'serve-toss', these
// same keys steer the serve-aim crosshair instead — movePlayer() is only
// ever called outside those states, so no special-casing is needed here.)
//
// NET-RUSH RISK/REWARD, part 3: closing the distance to the net is
// deliberately slower than moving sideways or retreating. Both players now
// start every point at their true baseline (see resetServe()), so reaching
// net-bonus range takes a genuine, sustained push forward — not a couple of
// frames of instant repositioning — matching how "coming to net" behind a
// serve or approach shot is an actual commitment in real tennis, not a free
// teleport. Only the net-ward component of movement is slowed; sideways
// tracking and retreating toward your own baseline stay at full speed.
const NET_APPROACH_SPEED_MULT = 0.55;

function movePlayer() {
  const { lo: yLo, hi: yHi } = playerYBounds();
  const prevX = player.x, prevY = player.y;
  let dx = 0, dy = 0;
  if (keys['ArrowLeft']  || keys['KeyA']) dx -= 1;
  if (keys['ArrowRight'] || keys['KeyD']) dx += 1;
  if (keys['ArrowUp']    || keys['KeyW']) dy -= 1; // up = toward the net
  if (keys['ArrowDown']  || keys['KeyS']) dy += 1; // down = toward the baseline
  if (dx !== 0 || dy !== 0) {
    // Normalize so diagonal movement isn't faster than axis-aligned movement.
    const len = Math.hypot(dx, dy) || 1;
    // Player's net direction is "up" (dy < 0) — throttle only that component.
    const netMult = dy < 0 ? NET_APPROACH_SPEED_MULT : 1;
    player.x += (dx / len) * player.speed;
    player.y += (dy / len) * player.speed * netMult;
  }
  player.x = Math.max(CL, Math.min(CR - player.w, player.x));
  player.y = Math.max(yLo, Math.min(yHi, player.y));
  // Walk animation is keyed off REAL displacement (post-clamp), not just
  // held keys, so legs settle back to a stand the instant a wall/boundary
  // actually stops the player rather than still swinging in place.
  updateWalkAnim(player, player.x !== prevX || player.y !== prevY);
}
// ── AI POSITIONING (approach/retreat) ───────────────────────────────
// Two distinct modes, matching how a real player actually moves:
//  1. INTERCEPT — the ball is on the AI's side and heading toward it
//     (ball.dy < 0). Track it directly in both X and Y so the AI can
//     genuinely reach short balls (moving up) and deep balls (staying
//     back), not just side to side.
//  2. RECOVER — the ball is on the PLAYER's side (just been returned).
//     The AI moves to a strategic "ready position" instead of camping on
//     the net-buffer line: if the AI's last shot was weak/short, it
//     anticipates a weak reply and creeps in toward the net to attack;
//     if its last shot was a deep/defensive shot (or it's early in the
//     rally), it recovers toward the baseline to be ready for pace.
// The AI's default posture is the baseline — net-rushing is a rare,
// deliberate payoff for genuinely dominating a rally, not a routine tactic.
// The game is meant to be about building a point and winning it with a
// well-placed shot, not a footrace to the net, so the bar to come in is set
// high on purpose and even meeting it doesn't guarantee the AI takes it.
const AI_READY_BASELINE = 0.85; // recovery depth (0=net buffer, 1=baseline) — the default, essentially always, same for every opponent
// Mutable (BASE_ = exhibition/default) so a serve-and-volley style
// opponent can commit to net much sooner/more often/more fully than a
// baseline grinder — see AI_MIN_RALLY_BEFORE_NET_RUSH etc. below.
const BASE_AI_READY_APPROACH = 0.62;
let AI_READY_APPROACH = BASE_AI_READY_APPROACH; // recovery depth once committed to net — barely past ready position, not a full charge to net

// How many shots the AI has to have exchanged THIS point before it will
// ever consider following a shot in to net. Below this, it always recovers
// to the baseline regardless of contact depth — a real player doesn't storm
// the net off a single early exchange; net-rushing is a payoff for actually
// working a point, not a reflex. (rally counts every hit, both sides,
// resetting to 0 each point — see doBounce()/resetServe().)
//
// Net play kept feeling like the AI's main strategy even after repeated
// tuning passes, which means it needed a hard cut, not another nudge —
// these thresholds are deliberately steep now. Net-rushing should read as a
// rare, surprising thing the AI occasionally pulls off in a long point, not
// something that comes up in a normal-length rally at all.
const BASE_AI_MIN_RALLY_BEFORE_NET_RUSH = 14;
let AI_MIN_RALLY_BEFORE_NET_RUSH = BASE_AI_MIN_RALLY_BEFORE_NET_RUSH;
// How many of the AI's OWN last shots need to have landed genuinely close
// to net (i.e. it had to volley/approach, not just a deep groundstroke)
// before it even CONSIDERS following in. A single shallow contact used to
// flip the switch instantly — often just because a fast incoming ball
// forced the AI to intercept it up near net once, not because the AI had
// actually built any real advantage in the point. Requiring a longer streak
// means occasional forced net contact doesn't read as "the AI decided to
// rush" — it only becomes ELIGIBLE once it's clearly dominating the exchange.
const BASE_AI_ATTACK_STREAK_NEEDED = 4;
let AI_ATTACK_STREAK_NEEDED = BASE_AI_ATTACK_STREAK_NEEDED;
// Even once eligible, the AI only actually commits to coming in this
// fraction of the time it re-evaluates — so meeting the bar is necessary
// but not sufficient. This is what keeps net play feeling like a background
// feature instead of the AI's default win condition.
const BASE_AI_ATTACK_COMMIT_CHANCE = 0.15;
let AI_ATTACK_COMMIT_CHANCE = BASE_AI_ATTACK_COMMIT_CHANCE;

function aiRecoveryDepth() {
  const { lo, hi } = aiYBounds();
  const halfSpan = hi - lo || 1;
  // Before the AI has actually hit anything yet this point (e.g. right
  // after the toss, or right after the player's serve is still incoming),
  // there's no shot to judge — just recover to the baseline like normal.
  if (!ai.hasHit) { ai.attackStreak = 0; ai.committedToNet = false; return lo + AI_READY_BASELINE * halfSpan; }

  const contactDepth = Math.max(0, Math.min(1, (ai.contactY - lo) / halfSpan)); // 0=net, 1=baseline
  const thisShotWasClose = contactDepth < 0.25;

  // Don't even consider attacking until the point has actually developed a
  // bit — otherwise a single early power shot (an 18%-random pick, totally
  // unrelated to court position — see decideShotType()) was enough to send
  // the AI storming the net right out of the serve exchange.
  if (rally < AI_MIN_RALLY_BEFORE_NET_RUSH) { ai.attackStreak = 0; ai.committedToNet = false; return lo + AI_READY_BASELINE * halfSpan; }

  // Track a streak of consecutive close-to-net AI contacts. Any shot struck
  // from deep resets it immediately (and un-commits it from net if it had
  // committed) — one defensive shot is enough evidence the AI isn't
  // actually dominating this exchange right now, even if it was up close a
  // moment earlier.
  if (thisShotWasClose) {
    ai.attackStreak = (ai.attackStreak || 0) + 1;
  } else {
    ai.attackStreak = 0;
    ai.committedToNet = false;
  }

  const eligible = ai.attackStreak >= AI_ATTACK_STREAK_NEEDED;
  // Roll to commit only on the frame it FIRST becomes eligible (or while
  // already committed, stay committed) — re-rolling every single shot would
  // average out to "eventually commits anyway" over a long rally, which
  // defeats the point of it being a rare tactic rather than an inevitability.
  if (eligible && !ai.committedToNet) {
    ai.committedToNet = Math.random() < AI_ATTACK_COMMIT_CHANCE;
  }
  const target = ai.committedToNet ? AI_READY_APPROACH : AI_READY_BASELINE;
  return lo + target * halfSpan;
}

// Predicts where the ball will cross a FIXED reference depth, using its
// current straight-line velocity (ignores spin curve/decay — close enough
// for movement targeting, not the actual physics). The reference depth is
// the AI's normal return-ready depth, NOT its full baseline — predicting
// all the way out to the baseline overshoots badly on a serve/shot that's
// aimed to land in the shallower service box, since a straight-line
// projection keeps extrapolating the ball's drift long after it would
// actually have reached (and been hit at) a much shallower point. Using a
// fixed reference line (rather than the AI's own live Y, which moves every
// frame) also avoids a feedback loop where the target chases the chaser.
// Without prediction at all, tracking the ball's LIVE X position every
// frame is pure pursuit, which structurally always lags a fast-moving ball
// — real players start moving toward where the ball is GOING, not where it
// currently is.
function predictBallX() {
  const bounds = aiYBounds();
  const refY = returnReadyY(bounds);
  if (Math.abs(ball.dy) >= 0.01) {
    const t = (refY - ball.y) / ball.dy;
    if (t >= 0) return ball.x + ball.dx * t;
  }
  return ball.x; // ball already past the reference depth — just use its live position
}

function moveAI() {
  // A live drop shot headed for the AI needs genuine net coverage to
  // defend — exempt CHASING it (not the AI's own decision to attack) from
  // the attack-only net-rush lockout above. Without this, the lockout
  // (meant only to stop the AI electively camping at net) would make an
  // early-rally drop shot physically impossible to reach no matter how
  // fast the AI closed the distance, rather than just a real challenge.
  const chasingDrop = ball.isDrop && ball.dy < 0;
  const { lo: yLo, hi: yHi } = aiYBounds(chasingDrop);
  // A ball that's still physically on the AI's side but moving AWAY from
  // the AI (dy > 0, just been struck by the AI itself and heading back
  // toward the player) is NOT a reason to keep chasing — it takes a few
  // frames to actually cross NET_Y after being hit, and during that window
  // this used to still count as "ball on my side" and glue the AI to
  // wherever it just struck from (almost always right up at the net after
  // any shot the AI reached by moving forward). That's what was causing the
  // AI to look like it "instantly" rushes the net every point: it wasn't
  // deciding to attack at all, it just never actually left after its last
  // shot. Only a ball still headed toward the AI's side counts as live
  // threat requiring pursuit.
  const ballThreatensAiSide = ball.y < NET_Y && ball.dy <= 0;
  // "incoming" means the ball is headed toward the AI's court, whether or
  // not it has actually crossed the net yet — a real player starts moving
  // toward a serve/shot the instant it's struck, not only once it crosses
  // to their side. Waiting for ballOnAiSide before reacting was costing the
  // AI roughly half the ball's flight time on every serve/deep shot.
  const incoming = ball.dy < 0;

  let tgtX, tgtY;
  if (incoming || ballThreatensAiSide) {
    // Ball is live on the AI's side (approaching or already past the AI,
    // e.g. a lob) — go get it for real, full range. Aim X at where the
    // ball will END UP (predicted against a fixed reference depth), not
    // where it is right now, so the AI doesn't perpetually lag a fast
    // serve/shot. Once the ball has actually reached/passed that reference
    // depth, the prediction's job is done — switch to tracking its live X
    // for final precision. (Checking against the ball's OWN progress here,
    // not the AI's — the AI's y can be clamped/stuck partway, which made an
    // AI-position-relative proximity check fire early and undo the benefit
    // of predicting in the first place.)
    if (ball.isLob) {
      // A lob's landing spot is fully known the instant it's launched (a
      // fixed eased-arc target, not a constant-velocity line — see
      // advanceLob()), so there's nothing to predict: beeline straight for
      // where it's actually going to land for the whole flight. Using
      // predictBallX() here was the bug — it assumes straight-line motion
      // and extrapolates from the CURRENT per-frame dx/dy, which is nearly
      // zero for most of a lob's slow-climb opening, so it produced a
      // wildly wrong target for a big chunk of the flight and often left
      // the AI standing in the wrong spot by the time the ball came down,
      // even on a lob heading straight for it.
      tgtX = ball.lobTargetX - ai.w/2;
      tgtY = ball.lobTargetY - ai.h/2;
    } else if (ball.isDrop) {
      // Exactly the same bug as the lob had, and the same fix: a drop
      // shot's landing spot is also a fixed eased-arc target known the
      // instant it's struck (see advanceDrop()), not a constant-velocity
      // line — so predictBallX()'s straight-line extrapolation is wrong
      // here too. It was worse for a drop shot than it ever was for a lob:
      // predictBallX() projects out to returnReadyY(aiYBounds()), a depth
      // deep in the AI's own court that a shallow drop shot (landing near
      // net, see DROP_TARGET_DEPTH) never actually reaches, so the
      // projection extrapolated the ball's tiny per-frame drift over a much
      // longer "flight" than the drop shot actually has — overshooting the
      // real target, often by more than the width of the court, for the
      // entire ~22-frame flight. The AI chased that wrong spot the whole
      // time and landed nowhere near the real ball, turning a shot it
      // should often have at least contested into an automatic winner.
      // Beelining to the real, known target fixes it the same way it fixed
      // the lob.
      tgtX = ball.dropTargetX - ai.w/2;
      tgtY = ball.dropTargetY - ai.h/2;
    } else {
      tgtY = ball.y - ai.h/2;
      const pastReference = ball.y <= returnReadyY(aiYBounds());
      tgtX = (incoming && !pastReference) ? predictBallX() - ai.w/2 : ball.x - ai.w/2;
    }
  } else {
    // Ball is on the player's side — recover to a sensible ready position
    // rather than tracking the ball's (irrelevant) far-side coordinates.
    tgtX = W/2 - ai.w/2 + (ball.x - W/2) * 0.25; // lean slightly toward the ball's side
    tgtY = aiRecoveryDepth();
  }
  tgtX = Math.max(CL, Math.min(CR - ai.w, tgtX));
  tgtY = Math.max(yLo, Math.min(yHi, tgtY));

  const diffX = tgtX - ai.x, diffY = tgtY - ai.y;
  const prevAiX = ai.x, prevAiY = ai.y;
  // AI's net direction is "increasing y" (toward NET_Y) — throttle only
  // that component, same as the player, so the AI can't dash to net-bonus
  // range any faster than a human could. Retreating toward its own
  // baseline (diffY < 0) stays at full speed.
  const aiNetMult = diffY > 0 ? NET_APPROACH_SPEED_MULT : 1;
  ai.x += Math.sign(diffX) * Math.min(ai.speed, Math.abs(diffX));
  ai.y += Math.sign(diffY) * Math.min(ai.speed * aiNetMult, Math.abs(diffY));
  ai.x = Math.max(CL, Math.min(CR - ai.w, ai.x));
  ai.y = Math.max(yLo, Math.min(yHi, ai.y));
  updateWalkAnim(ai, ai.x !== prevAiX || ai.y !== prevAiY);
}

// ── UPDATE ───────────────────────────────────────────────────────────
// Menu-like states have no simulation to advance — the loop just holds on
// the current frame until a click/keypress moves gState somewhere live.
const FROZEN_STATES = ['title', 'loadout-select', 'court-select', 'tournament-intro', 'tournament-round-win', 'tournament-eliminated', 'tournament-champion'];
function update() {
  if (paused) return;
  if (FROZEN_STATES.includes(gState)) return;

  // Crowd animation: always advance the idle-sway clock, and ease the cheer
  // level toward 1 whenever a point has just ended, back toward 0 otherwise
  // — an eased chase instead of a snap so the crowd winds up and settles
  // down instead of instantly popping in and out of "cheering."
  crowdT++;
  const cheerTarget = gState === 'point-end' ? 1 : 0;
  cheerT += (cheerTarget - cheerT) * 0.08;

  if (player.hitTimer > 0) player.hitTimer--;
  if (player.flashAlpha > 0) player.flashAlpha = Math.max(0, player.flashAlpha - 0.1);
  if (ai.hitTimer > 0) ai.hitTimer--;
  if (ai.flashAlpha > 0) ai.flashAlpha = Math.max(0, ai.flashAlpha - 0.1);
  if (shotLabel) { shotLabel.timer--; if (shotLabel.timer <= 0) shotLabel = null; }

  if (gState === 'serving') {
    // Waiting/aiming phase: the timing bar (player) or countdown (AI) runs
    // exactly as before, but the ball itself is held — nothing bounces or
    // floats on screen here. The server just stands ready. Arrow/WASD now
    // steers the aim crosshair inside the target box instead of moving the
    // player, who stays planted at their serve stance.
    const server = currentServer === 'player' ? player : ai;
    server.windup = 0;
    if (currentServer === 'player') {
      let dx = 0, dy = 0;
      if (keys['ArrowLeft']  || keys['KeyA']) dx -= 1;
      if (keys['ArrowRight'] || keys['KeyD']) dx += 1;
      if (keys['ArrowUp']    || keys['KeyW']) dy -= 1;
      if (keys['ArrowDown']  || keys['KeyS']) dy += 1;
      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy) || 1;
        aimX = Math.max(0, Math.min(1, aimX + (dx/len) * AIM_MOVE_SPEED));
        aimY = Math.max(0, Math.min(1, aimY + (dy/len) * AIM_MOVE_SPEED));
        recomputeServeZones();
      }

      serveBarPos += SERVE_BAR_SPEED * serveBarDir;
      if (serveBarPos >= 1) { serveBarPos = 1; serveBarDir = -1; }
      if (serveBarPos <= 0) { serveBarPos = 0; serveBarDir = 1; }
    } else {
      if (--aiDelay <= 0) {
        const succ = Math.random() < AI_SERVE_SUCCESS;
        const pwr  = succ && Math.random() < AI_SERVE_POWER_CHANCE;
        commitServe(succ, pwr);
      }
    }
    return;
  }

  if (gState === 'serve-toss') {
    // One-shot animation: the ball tosses up and the racket swings through
    // to meet it overhead. Success/power was already decided at commit
    // time (in commitServe) — this phase is purely the visual windup, and
    // launchServe() only fires once it completes. The player stays planted
    // (aiming already happened during 'serving').
    const server = currentServer === 'player' ? player : ai;
    const t = 1 - (tossAnimTimer / TOSS_ANIM_FRAMES); // 0 at commit -> 1 at hit
    server.windup = Math.min(1, t * 1.3);
    if (--tossAnimTimer <= 0) {
      const { success, isPower } = pendingServe;
      pendingServe = null;
      launchServe(success, isPower);
    }
    return;
  }

  if (gState === 'serve-flight') {
    movePlayer(); moveAI();
    ball.x += ball.dx; ball.y += ball.dy;
    // A 'wide' miss is SUPPOSED to sail past the sideline, so skip the
    // court-wall bounce for it — otherwise it'd bounce right back into
    // play and never actually read as a wide miss.
    if (missType !== 'wide') {
      if (ball.x - ball.r < CL) { ball.x = CL + ball.r; ball.dx = Math.abs(ball.dx); }
      if (ball.x + ball.r > CR) { ball.x = CR - ball.r; ball.dx = -Math.abs(ball.dx); }
    }
    updateAnticipation(player, true); updateAnticipation(ai, false);

    // The RECEIVER can return the serve the moment it reaches them — this
    // was missing entirely before: serve-flight only checked where the
    // ball LANDED, so by the time a good serve resolved into 'playing' it
    // had usually already flown past the receiver with no real chance to
    // hit it. Only the receiver (not the server) can hit their own serve,
    // matching decideShotType/doBounce's isPlayer-branch behavior exactly
    // like a normal rally shot — no separate "serve return" mechanic. Only
    // a serve that's actually aimed AT the box (missType === null) is
    // returnable — a net/long/wide miss fails by construction and must
    // resolve as a fault, not get intercepted and turned into a rally.
    const receiverIsPlayer = currentServer === 'ai';
    if (missType === null) {
      if (receiverIsPlayer && ball.dy > 0 && overlaps(player, playerReachY(), playerReachX())) { doBounce(player, true); gState = 'playing'; return; }
      if (!receiverIsPlayer && ball.dy < 0 && overlaps(ai, aiReachY())) { doBounce(ai, false); gState = 'playing'; return; }
    }

    const side = Math.sign(serveLineY - ball.y);
    if (side !== servePrevSide) resolveServeLanding();
    servePrevSide = side;
    return;
  }

  if (gState === 'fault-pause') { if (--faultTimer <= 0) resetServe(); return; }

  if (gState === 'point-end') {
    if (--endTimer <= 0) {
      if (gameOverPending) {
        (ptWin === 'player' ? player : ai).games++;
        player.pts = 0; ai.pts = 0;
        currentServer = currentServer === 'player' ? 'ai' : 'player';
        gameOverPending = false;
        updateHud();
        if (tournament.active) {
          const mw = checkMatchWin();
          if (mw) { handleTournamentMatchEnd(mw); return; }
        }
      }
      beginPoint();
    }
    return;
  }

  // ── PLAYING ──
  movePlayer(); moveAI();
  if (ball.isLob) {
    advanceLob();
  } else if (ball.isDrop) {
    advanceDrop();
  } else {
    ball.x += ball.dx; ball.y += ball.dy;
    if (ball.spin !== 0) {
      ball.dx += ball.spin; ball.spin *= SPIN_DECAY;
      if (Math.abs(ball.spin) < 0.01) ball.spin = 0;
      clampBallSpeed(); // spin nudges dx every frame — keep it under the same absolute ceiling
    }
    if (ball.x - ball.r < CL) { ball.x = CL + ball.r; ball.dx = Math.abs(ball.dx); }
    if (ball.x + ball.r > CR) { ball.x = CR - ball.r; ball.dx = -Math.abs(ball.dx); }
  }
  updateAnticipation(player, true); updateAnticipation(ai, false);
  // A live lob is unplayable by whichever pad gets caught up in net-rush
  // range AT ANY POINT during its flight — it sails past their reach no
  // matter where exactly they're standing left-right. This latches (see
  // ball.lobCaughtPlayer/lobCaughtAi) rather than re-checking position
  // live every frame: a fixed-speed AI can retreat out of the net zone in
  // well under a second, and once accurate lob-tracking meant it usually
  // then also got INTO position in time, that retreat was quietly
  // un-cooking the lob completely — a real net-rusher caught out by a lob
  // doesn't get to sprint back and save it.
  if (ball.isLob) {
    if (isPadUpAtNet(player, true)) ball.lobCaughtPlayer = true;
    if (isPadUpAtNet(ai, false)) ball.lobCaughtAi = true;
  }
  const playerCanPlayBall = !ball.isLob || !ball.lobCaughtPlayer;
  const aiCanPlayBall = !ball.isLob || !ball.lobCaughtAi;
  if (ball.dy > 0 && playerCanPlayBall && overlaps(player, playerReachY(), playerReachX())) doBounce(player, true);
  if (ball.dy < 0 && aiCanPlayBall && overlaps(ai, aiReachY())) doBounce(ai, false);
  // A lob that finishes its full flight without being touched has landed —
  // score it exactly like a ball that flew past the baseline normally.
  if (ball.isLob && ball.lobT >= 1) {
    if (ball.lobTargetY > NET_Y) awardPoint('ai', 'normal');
    else awardPoint('player', 'normal');
    return;
  }
  if (ball.isDrop && ball.dropT >= 1) {
    if (ball.dropTargetY > NET_Y) awardPoint('ai', 'normal');
    else awardPoint('player', 'normal');
    return;
  }
  if (ball.y - ball.r > CB) awardPoint('ai', 'normal');
  if (ball.y + ball.r < CT) awardPoint('player', 'normal');
}

// ── DRAW ─────────────────────────────────────────────────────────────
// Per-surface texture: subtle marks drawn over the base fill so the court
// doesn't read as one flat color. Deterministic (seeded from fixed grid
// positions, not Math.random()) so the texture doesn't flicker every frame.
function drawCourtTexture(c) {
  cx.save();
  cx.beginPath(); cx.rect(CL, CT, CR-CL, CB-CT); cx.clip();

  if (currentCourt === 'clay') {
    // Fine brushed/raked grain: short horizontal streaks in a soft grid,
    // like a clay court freshly swept.
    cx.strokeStyle = 'rgba(255,255,255,0.05)'; cx.lineWidth = 1;
    for (let y = CT + 6; y < CB; y += 7) {
      cx.beginPath(); cx.moveTo(CL, y); cx.lineTo(CR, y); cx.stroke();
    }
    cx.strokeStyle = 'rgba(0,0,0,0.06)';
    for (let y = CT + 3; y < CB; y += 11) {
      cx.beginPath(); cx.moveTo(CL, y); cx.lineTo(CR, y); cx.stroke();
    }
  } else if (currentCourt === 'grass') {
    // Mowing stripes: alternating light/dark bands running the length of
    // the court, like real mown grass.
    const stripeW = 22;
    let i = 0;
    for (let x = CL; x < CR; x += stripeW) {
      cx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.045)';
      cx.fillRect(x, CT, Math.min(stripeW, CR-x), CB-CT);
      i++;
    }
  } else {
    // Hard court: faint large panel seams, like poured/painted concrete
    // sections.
    cx.strokeStyle = 'rgba(255,255,255,0.05)'; cx.lineWidth = 1;
    for (let x = CL; x <= CR; x += 40) { cx.beginPath(); cx.moveTo(x, CT); cx.lineTo(x, CB); cx.stroke(); }
    for (let y = CT; y <= CB; y += 40) { cx.beginPath(); cx.moveTo(CL, y); cx.lineTo(CR, y); cx.stroke(); }
    cx.fillStyle = 'rgba(255,255,255,0.03)';
    cx.fillRect(CL, CT, CR-CL, (CB-CT)*0.5);
  }
  cx.restore();
}

// A proper-looking net: a soft ground shadow, a mesh band with real
// crosshatch weave, a solid top tape/cord, and posts with base + cap detail
// instead of plain rectangles.
function drawNet(lineColor) {
  const netH = 15; // visual height of the mesh band above the net line
  const topY = NET_Y - netH, botY = NET_Y + 2;

  // soft shadow on the court where the net meets the ground
  cx.fillStyle = 'rgba(0,0,0,0.12)';
  cx.fillRect(CL-6, NET_Y+1, (CR-CL)+12, 4);

  // mesh band background (slightly darker than the strap so the weave pops)
  cx.fillStyle = 'rgba(20,20,20,0.28)';
  cx.fillRect(CL, topY, CR-CL, netH);

  // crosshatch mesh weave, clipped to the band
  cx.save();
  cx.beginPath(); cx.rect(CL, topY, CR-CL, netH); cx.clip();
  cx.strokeStyle = 'rgba(255,255,255,0.55)'; cx.lineWidth = 0.6;
  const cell = 5;
  for (let x = CL - netH; x <= CR + netH; x += cell) {
    cx.beginPath(); cx.moveTo(x, topY); cx.lineTo(x + netH, botY); cx.stroke();
    cx.beginPath(); cx.moveTo(x, botY); cx.lineTo(x + netH, topY); cx.stroke();
  }
  cx.restore();

  // slight sag in the middle (real nets dip a little at center) via a thin
  // curved shading line over the mesh
  cx.strokeStyle = 'rgba(0,0,0,0.15)'; cx.lineWidth = 3;
  cx.beginPath();
  cx.moveTo(CL, topY + 2);
  cx.quadraticCurveTo(W/2, topY + 5, CR, topY + 2);
  cx.stroke();

  // top tape/cord — solid band along the top edge
  cx.fillStyle = lineColor;
  cx.fillRect(CL - 4, topY - 3, (CR-CL) + 8, 4);
  cx.strokeStyle = 'rgba(0,0,0,0.25)'; cx.lineWidth = 1;
  cx.strokeRect(CL - 4, topY - 3, (CR-CL) + 8, 4);

  // posts: a base cap, a shaft, a top knob — replaces the old plain rects
  [CL - 8, CR + 3].forEach(px => {
    cx.fillStyle = '#3a3a3a';
    cx.fillRect(px, topY - 5, 5, netH + 10);
    cx.fillStyle = lineColor;
    cx.fillRect(px - 1, topY - 7, 7, 4); // cap
    cx.fillStyle = 'rgba(0,0,0,0.25)';
    cx.fillRect(px, botY + 3, 5, 3); // base shadow
  });
}

function drawCourt() {
  const c = COURTS[currentCourt] || COURTS.clay;
  cx.fillStyle = c.color; cx.fillRect(0, 0, W, H);
  cx.fillStyle = c.colorDark;
  cx.fillRect(0, 0, CL, H); cx.fillRect(CR, 0, W-CR, H);
  cx.fillRect(0, 0, W, CT); cx.fillRect(0, CB, W, H-CB);
  cx.fillStyle = 'rgba(255,255,255,0.05)';
  [['top','left'],['top','right'],['bottom','left'],['bottom','right']].forEach(([e,s]) => {
    const b = boxRect(e,s); cx.fillRect(b.x,b.y,b.w,b.h);
  });
  drawCourtTexture(c);
  cx.strokeStyle = c.lineColor; cx.lineWidth = 2;
  cx.strokeRect(CL, CT, CR-CL, CB-CT);
  cx.beginPath();
  cx.moveTo(CL, svcT); cx.lineTo(CR, svcT);
  cx.moveTo(CL, svcB); cx.lineTo(CR, svcB);
  cx.moveTo(W/2, svcT); cx.lineTo(W/2, svcB);
  cx.stroke();
  drawStands();
  drawNet(c.lineColor);
}

// ── CROWD / STANDS ───────────────────────────────────────────────────
// Fills the dark side margins (0..CL and CR..W) with tiered concrete
// bleacher rows full of small pixel-block fans, instead of leaving them
// flat and empty. Fans idle-bob gently during normal play and cheer
// (bigger hop, arms up) for a stretch after each point ends, driven by
// cheerT below.
let crowdT = 0;       // free-running animation clock, advances every frame
let cheerT = 0;       // 0..1 "how much are the stands currently cheering" — eased toward a target each frame
const STAND_ROW_H = 16;    // height of one bleacher tier, px
const STAND_FAN_W = 6, STAND_FAN_H = 9, STAND_FAN_GAP = 1;
// Small deterministic pseudo-random generator seeded by index, NOT
// Math.random() — the crowd's per-fan color/phase variety has to be STABLE
// across frames (same fan, same seat, same look) rather than re-rolling and
// flickering every draw call.
function seededFrac(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }
const FAN_SHIRT_COLORS = ['#e8543f','#f0c93f','#4aa8e0','#7ad068','#e07ad0','#f0f0f0','#c0782f','#9a5cf0'];
const STAND_CONCRETE = '#5a5f5a', STAND_CONCRETE_DARK = '#454945';

function drawFanBlock(x, y, w, h, shirtColor, skinColor, bounce, cheering) {
  // Tiny pixel-block person: a round head + a torso block, cheap enough to
  // draw dozens per frame. `bounce` is a small vertical offset (idle sway
  // normally, a bigger hop while cheering); `cheering` raises little arm
  // stubs above the head instead of staying still.
  const headR = w * 0.34;
  const bodyY = y - bounce;
  cx.fillStyle = shirtColor;
  cx.fillRect(Math.round(x), Math.round(bodyY + headR * 1.5), w, h - headR * 1.5);
  cx.fillStyle = skinColor;
  cx.beginPath(); cx.arc(x + w/2, bodyY + headR, headR, 0, Math.PI*2); cx.fill();
  if (cheering) {
    cx.strokeStyle = skinColor; cx.lineWidth = Math.max(1, w*0.22);
    cx.beginPath();
    cx.moveTo(x + w*0.1, bodyY + headR*1.7); cx.lineTo(x - w*0.5, bodyY - headR*0.6);
    cx.moveTo(x + w*0.9, bodyY + headR*1.7); cx.lineTo(x + w*1.5, bodyY - headR*0.6);
    cx.stroke();
  }
}

// Tiered "bowl" layout: tiers step OUTWARD (horizontally, away from the
// court edge) as they rise, like a real stadium cross-section — the front
// row sits right at court level (lowest, closest), and each tier further
// back is both a little higher on screen (via a vertical stagger per tier,
// giving the classic raked-seating look in a 2D side view) and drawn with a
// slightly darker shade to read as "further away." `courtEdgeX` is the x
// the tiers step away FROM (CL for the left stand, CR for the right), and
// `dir` is -1 (tiers grow toward x=0) or +1 (tiers grow toward x=W).
const STAND_TIERS = 5;
const STAND_TIER_STAGGER = 3; // px each successive tier rises, for the raked-bowl look
function drawStandSection(courtEdgeX, dir, maxW) {
  const tierW = maxW / STAND_TIERS;
  const cols = Math.max(1, Math.floor(H / (STAND_FAN_W + STAND_FAN_GAP)));
  for (let tier = 0; tier < STAND_TIERS; tier++) {
    // x position of this tier's strip, stepping away from the court.
    const tx = dir > 0 ? courtEdgeX + tier * tierW : courtEdgeX - (tier + 1) * tierW;
    const stagger = tier * STAND_TIER_STAGGER; // rows further back sit "higher" (toward y=0)
    const tierShade = tier % 2 === 0 ? STAND_CONCRETE : STAND_CONCRETE_DARK;
    // Darken further tiers slightly so depth reads even without perspective.
    const depthDarken = tier / STAND_TIERS * 0.35;
    cx.fillStyle = darkenColor(tierShade, depthDarken);
    cx.fillRect(tx, -stagger, tierW, H + stagger);
    // A thin highlight on the riser facing the court, for a stepped-tier look.
    cx.fillStyle = 'rgba(255,255,255,0.08)';
    if (dir > 0) cx.fillRect(tx, -stagger, 1, H + stagger);
    else cx.fillRect(tx + tierW - 1, -stagger, 1, H + stagger);

    for (let col = 0; col < cols; col++) {
      const seedBase = tier * 97 + col * 13 + (dir > 0 ? 5000 : 0);
      // Leave a fraction of seats empty so it doesn't look like a uniform
      // grid of identical fans packed shoulder to shoulder.
      if (seededFrac(seedBase + 3) < 0.12) continue;
      const shirt = FAN_SHIRT_COLORS[Math.floor(seededFrac(seedBase) * FAN_SHIRT_COLORS.length)];
      const skin = seededFrac(seedBase + 1) > 0.5 ? '#e8b98a' : '#a86f4a';
      const phase = seededFrac(seedBase + 2) * Math.PI * 2;
      // Cheering fans bounce higher and faster; idle fans just sway a little.
      const idleBounce = Math.sin(crowdT * 0.06 + phase) * 0.7;
      const cheerBounce = Math.max(0, Math.sin(crowdT * 0.4 + phase)) * 3.2;
      const bounce = idleBounce + cheerT * cheerBounce;
      // Fans sit at the FRONT (court-facing) edge of each tier's own strip
      // — that's where that tier's seat platform actually is, with its
      // riser wall behind it. For the right stand (dir>0) the court-facing
      // edge is the strip's left side; for the left stand (dir<0) it's the
      // strip's right side.
      const fanX = dir > 0
        ? tx + 2
        : tx + tierW - STAND_FAN_W - 2;
      const fanY = col * (STAND_FAN_W + STAND_FAN_GAP) + 1 - stagger;
      drawFanBlock(fanX, fanY, STAND_FAN_W, STAND_FAN_H, shirt, skin, bounce, cheerT > 0.4);
    }
  }
}

function drawStands() {
  cx.save();
  cx.beginPath(); cx.rect(0, 0, W, H); cx.clip(); // keep staggered tiers from drawing outside the canvas
  drawStandSection(CL, -1, CL);       // left stand: front row at CL, tiers step toward x=0
  drawStandSection(CR, 1, W - CR);    // right stand: front row at CR, tiers step toward x=W
  cx.restore();
}

function drawServiceMarkers() {
  if (!['serving','serve-toss','serve-flight','fault-pause'].includes(gState)) return;
  const end = currentServer === 'player' ? 'top' : 'bottom';
  const box = boxRect(end, targetSide);
  const pulse = 0.18 + Math.abs(Math.sin(Date.now()/220))*0.14;
  cx.fillStyle = `rgba(216,224,24,${pulse})`;
  cx.fillRect(box.x, box.y, box.w, box.h);
  cx.strokeStyle = 'rgba(216,224,24,0.8)'; cx.lineWidth = 1.5;
  cx.strokeRect(box.x, box.y, box.w, box.h);

  // Subtle corner shading — a soft red glow that grows toward each corner,
  // giving a visual read on where the box gets riskier before the player
  // even checks the timing bar width.
  if (gState === 'serving' || gState === 'serve-toss') {
    cx.save();
    cx.beginPath(); cx.rect(box.x, box.y, box.w, box.h); cx.clip();
    const corners = [[box.x, box.y], [box.x+box.w, box.y], [box.x, box.y+box.h], [box.x+box.w, box.y+box.h]];
    for (const [gx, gy] of corners) {
      const grad = cx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(box.w, box.h) * 0.55);
      grad.addColorStop(0, 'rgba(230,60,50,0.32)');
      grad.addColorStop(1, 'rgba(230,60,50,0)');
      cx.fillStyle = grad;
      cx.fillRect(box.x, box.y, box.w, box.h);
    }
    cx.restore();
  }

  const standY = currentServer === 'player' ? CB-18 : CT;
  const sx2 = serverSide === 'left' ? CL : W/2;
  cx.fillStyle = 'rgba(74,184,240,0.15)';
  cx.fillRect(sx2, standY, W/2-CL, 18);
}

// The movable '+' aim crosshair. Only meaningful during 'serving' (while
// it's being steered) and 'serve-toss' (frozen at its final spot through
// the toss/hit animation, so the player can see exactly where they aimed).
function drawAimCrosshair() {
  if (gState !== 'serving' && gState !== 'serve-toss') return;
  const end = currentServer === 'player' ? 'top' : 'bottom';
  const box = boxRect(end, targetSide);
  const px = box.x + box.w * aimX, py = box.y + box.h * aimY;
  const isPlayer = currentServer === 'player';
  const color = isPlayer ? '#4ab8f0' : '#f07070';
  const size = 8;

  cx.save();
  cx.strokeStyle = color; cx.lineWidth = 2;
  cx.beginPath();
  cx.moveTo(px - size, py); cx.lineTo(px + size, py);
  cx.moveTo(px, py - size); cx.lineTo(px, py + size);
  cx.stroke();
  cx.strokeStyle = 'rgba(255,255,255,0.6)'; cx.lineWidth = 1;
  cx.beginPath(); cx.arc(px, py, size * 0.5, 0, Math.PI*2); cx.stroke();
  cx.restore();
}

function drawCharacter(pad, pal, isPlayer) {
  const cx0 = Math.round(pad.x + pad.w/2);
  const feetY = isPlayer ? pad.y - 2 : pad.y + pad.h + 2;
  const facing = isPlayer ? 1 : -1;
  const isSwinging = pad.hitTimer > 0;

  // armSwing: 0 = resting, 1 = fully extended contact, back down during follow-through
  let armSwing = 0;
  if (isSwinging) {
    const t = pad.hitTimer / STRIKE_FRAMES; // 1 at moment of hit -> 0 at end of follow-through
    armSwing = t > 0.55 ? 1 : (t / 0.55);
  } else if (pad.windup > 0) {
    // During the serve-toss animation the racket should swing up toward
    // contact (nearly full range); during a rally, windup is just a subtle
    // anticipation cue so it stays damped.
    armSwing = gState === 'serve-toss' ? pad.windup : pad.windup * 0.3;
  }

  // drawPerson renders the body, arm, and racket together (racket is
  // anchored internally to the exact hand position at every frame).
  drawPerson(pal, cx0, feetY, isPlayer, facing, armSwing, pad.flashAlpha, pad.walkPhase, pad.walkAmount);
}
// The visual toss: plays ONLY during the one-shot 'serve-toss' animation
// (never during the waiting/aiming 'serving' phase, so the ball no longer
// bounces while the player lines up the shot). Uses a parabola so it looks
// like an actual toss (fast up, slow at the peak, fast back down) timed to
// peak partway through the animation, with the hit landing near the end.
function drawTossBall() {
  if (gState !== 'serve-toss') return;
  const server = currentServer === 'player' ? player : ai;
  const isPlayer = currentServer === 'player';
  const startX = server.x + server.w/2;
  const baseY = isPlayer ? server.y - 6 : server.y + server.h + 6;

  // t goes 0 -> 1 across the whole toss animation; the toss arc itself is
  // eased to peak around t=0.55 and come back down by t~0.95 (contact),
  // matching the racket windup/swing timing in update()/drawCharacter().
  const t = 1 - (tossAnimTimer / TOSS_ANIM_FRAMES);
  const tossT = Math.min(1, t / 0.95);
  const arc = 4 * tossT * (1 - tossT); // 0..1..0
  const y = baseY - arc * TOSS_PEAK_HEIGHT * (isPlayer ? 1 : -1);

  drawTennisBallShape(startX, y, 6, currentBallColors().regular, 0.6);

  // small shadow under the toss to sell the height
  cx.fillStyle = 'rgba(0,0,0,0.15)';
  cx.beginPath(); cx.ellipse(startX, baseY, 5 * (1 - arc*0.6), 2, 0, 0, Math.PI*2); cx.fill();
}

// Draws a realistic-looking tennis ball: a radial gradient for a 3D shaded
// sphere look (light from the upper-left) plus the classic curved white
// seam stripe that wraps a real tennis ball, oriented along its direction
// of travel so it reads as spin/rotation rather than a static decal.
function drawTennisBallShape(x, y, r, baseColor, angle) {
  cx.save();

  // Shaded sphere body via radial gradient — brighter highlight offset
  // toward the "light source", darker toward the rim.
  const hlX = x - r * 0.35, hlY = y - r * 0.4;
  const grad = cx.createRadialGradient(hlX, hlY, r * 0.15, x, y, r * 1.15);
  grad.addColorStop(0, lightenColor(baseColor, 0.55));
  grad.addColorStop(0.55, baseColor);
  grad.addColorStop(1, darkenColor(baseColor, 0.45));
  cx.fillStyle = grad;
  cx.beginPath(); cx.arc(x, y, r, 0, Math.PI*2); cx.fill();

  // The seam: two curved arcs (like a real tennis ball's felt seam),
  // rotated by `angle` so it visually rolls as the ball moves.
  cx.save();
  cx.translate(x, y);
  cx.rotate(angle);
  cx.clip(new Path2D((() => {
    const p = new Path2D();
    p.arc(0, 0, r, 0, Math.PI*2);
    return p;
  })()));
  cx.strokeStyle = 'rgba(255,255,255,0.85)';
  cx.lineWidth = Math.max(1, r * 0.22);
  cx.beginPath();
  cx.moveTo(-r*1.1, -r*0.35);
  cx.quadraticCurveTo(0, r*0.9, r*1.1, -r*0.35);
  cx.stroke();
  cx.beginPath();
  cx.moveTo(-r*1.1, r*0.35);
  cx.quadraticCurveTo(0, -r*0.9, r*1.1, r*0.35);
  cx.stroke();
  cx.restore();

  // A bolder dark rim, matching the sprites' sticker-outline treatment, so
  // the ball reads as a solid graphic object against the court rather than
  // just a soft gradient blob.
  cx.strokeStyle = 'rgba(15,10,5,0.55)'; cx.lineWidth = Math.max(1.2, r * 0.18);
  cx.beginPath(); cx.arc(x, y, r - 0.6, 0, Math.PI*2); cx.stroke();
  cx.restore();
}

// Small color helpers used only for the ball's shading gradient — parse a
// '#rrggbb' hex color and blend it toward white (lighten) or black (darken).
function lightenColor(hex, amt) { return blendColor(hex, 255, amt); }
function darkenColor(hex, amt) { return blendColor(hex, 0, amt); }
function blendColor(hex, target, amt) {
  const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  const mix = (c) => Math.round(c + (target - c) * amt);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}
function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

let ballSpinAngle = 0; // accumulates over time so the seam rolls as the ball travels

// How far (px) the ball visually lifts off the "ground" at the peak of a
// lob, and how much bigger it draws there — pure screen-space fakery (the
// game stays flat 2D / no real height axis) but it's what actually sells
// "this went up and over your head" instead of just "this ball is slow."
const LOB_VISUAL_LIFT = 46;
const LOB_VISUAL_SCALE = 1.9;
// A drop shot barely clears the net — a much smaller, subtler arc than the
// lob's big up-and-over lift, so it visually reads as a soft touch shot.
const DROP_VISUAL_LIFT = 14;
const DROP_VISUAL_SCALE = 1.2;

function drawBall() {
  if (gState === 'serving' || gState === 'serve-toss') return;
  const isPower = ball.shotType === 'power', isSlice = ball.shotType === 'slice', isLob = ball.isLob, isDrop = ball.isDrop;
  const colors = currentBallColors();
  const ballColor = isLob ? '#b98cff' : isDrop ? '#f0d060' : isPower ? colors.power : isSlice ? colors.slice : colors.regular;
  const trailColor = isPower ? 'rgba(255,120,40,0.4)' : isSlice ? 'rgba(80,220,180,0.3)' : 'rgba(0,0,0,0.18)';

  if (isDrop) {
    const h = ball.dropHeight;
    cx.save();
    cx.globalAlpha = 0.35 * (1 - h * 0.6);
    cx.fillStyle = '#000';
    cx.beginPath();
    cx.ellipse(ball.x, ball.y, ball.r * (1 - h * 0.35), ball.r * 0.4 * (1 - h * 0.35), 0, 0, Math.PI*2);
    cx.fill();
    cx.restore();

    const liftedY = ball.y - h * DROP_VISUAL_LIFT;
    const scale = 1 + h * (DROP_VISUAL_SCALE - 1);
    ballSpinAngle += 0.1;
    drawTennisBallShape(ball.x, liftedY, ball.r * scale, ballColor, ballSpinAngle);
    return;
  }

  if (isLob) {
    // Ground shadow stays at the ball's true court position (x, y) and
    // shrinks/fades as the ball "rises" — the classic 2D height cue. The
    // ball itself is drawn lifted up the screen and enlarged, peaking at
    // lobHeight=1 (mid-flight) and settling back to the shadow at both ends.
    const h = ball.lobHeight;
    cx.save();
    cx.globalAlpha = 0.35 * (1 - h * 0.6);
    cx.fillStyle = '#000';
    cx.beginPath();
    cx.ellipse(ball.x, ball.y, ball.r * (1 - h * 0.35), ball.r * 0.4 * (1 - h * 0.35), 0, 0, Math.PI*2);
    cx.fill();
    cx.restore();

    const liftedY = ball.y - h * LOB_VISUAL_LIFT;
    const scale = 1 + h * (LOB_VISUAL_SCALE - 1);
    ballSpinAngle += 0.15;
    drawTennisBallShape(ball.x, liftedY, ball.r * scale, ballColor, ballSpinAngle);
    return;
  }

  if (Math.abs(ball.dy) > 1) {
    cx.save(); cx.fillStyle = trailColor;
    cx.beginPath();
    cx.ellipse(ball.x-ball.dx*0.9, ball.y-ball.dy*0.9, ball.r*(isPower?1.15:0.85), ball.r*0.55, 0, 0, Math.PI*2);
    cx.fill(); cx.restore();
  }
  // Spin the seam roughly in proportion to how fast the ball is moving,
  // so it visually rolls rather than staying static.
  ballSpinAngle += (Math.hypot(ball.dx, ball.dy) || 0) * 0.05;
  drawTennisBallShape(ball.x, ball.y, ball.r, ballColor, ballSpinAngle);
}
// A small pulsing banner at the top of the court showing break/game/match
// point, or (once no such stakes apply) a win streak of 3+ — see
// topBannerInfo(). Only shown while a point is actually live, never over a
// menu screen or the point-end overlay (which already has its own big text).
function drawTopBanner() {
  const info = topBannerInfo();
  if (!info) return;
  if (!['serving', 'serve-toss', 'serve-flight', 'playing'].includes(gState)) return;
  const pulse = 0.75 + Math.abs(Math.sin(Date.now() / 260)) * 0.25;
  cx.save();
  cx.globalAlpha = pulse;
  cx.textAlign = 'center';
  cx.fillStyle = info.color;
  cx.font = "16px 'Luckiest Guy', cursive";
  cx.fillText(info.text, W/2, 20);
  cx.restore();
  cx.textAlign = 'left';
}

function drawShotLabel() {
  if (!shotLabel) return;
  const a = Math.min(1, shotLabel.timer/20);
  const rise = (32 - shotLabel.timer) * 0.6;
  cx.save(); cx.globalAlpha = a; cx.fillStyle = shotLabel.color;
  cx.font = "17px 'Luckiest Guy', cursive"; cx.textAlign = 'center';
  cx.fillText(shotLabel.text, shotLabel.x, shotLabel.y - 14 - rise);
  cx.restore(); cx.textAlign = 'left';
}

function drawServeBar() {
  if (!(gState === 'serving' && currentServer === 'player')) return;
  const bx = W/2-90, by = CB-46, bw = 180, bh = 10;
  cx.fillStyle = 'rgba(0,0,0,0.35)'; cx.fillRect(bx, by, bw, bh);
  cx.fillStyle = 'rgba(216,224,24,0.5)';
  cx.fillRect(bx+zoneStart*bw, by, (zoneEnd-zoneStart)*bw, bh);
  cx.fillStyle = 'rgba(255,148,80,0.85)';
  cx.fillRect(bx+powerStart*bw, by, (powerEnd-powerStart)*bw, bh);
  cx.strokeStyle = '#f0ede4'; cx.lineWidth = 1; cx.strokeRect(bx, by, bw, bh);

  const inPower = serveBarPos >= powerStart && serveBarPos <= powerEnd;
  const mx = bx + serveBarPos*bw;
  cx.fillStyle = inPower ? '#ff9450' : '#4ab8f0';
  cx.beginPath();
  cx.moveTo(mx, by-5); cx.lineTo(mx-5, by-12); cx.lineTo(mx+5, by-12);
  cx.closePath(); cx.fill();
}

// Shared "console UI" panel renderer used by every card/button on the menu
// screens (mode cards, loadout/court cards, tournament bracket cards, pause
// buttons) — a rounded, drop-shadowed, top-beveled plaque instead of a flat
// filled rect, so the whole menu chrome reads as one consistent, chunky
// game-UI system rather than plain HTML-ish boxes. `accent` (a hex string)
// draws a thin inner glow line just inside the border for the games' color-
// coded elements (loadout accent, court color, etc.); omit it for neutral
// panels.
function drawPanel(x, y, w, h, opts = {}) {
  const {
    fill = '#1f3524', border = '#0a1409', borderWidth = 3, radius = 10,
    shadowColor = 'rgba(0,0,0,0.4)', shadowOffset = 4, accent = null,
  } = opts;
  cx.save();
  cx.fillStyle = shadowColor;
  cx.beginPath(); cx.roundRect(x + shadowOffset, y + shadowOffset, w, h, radius); cx.fill();

  cx.fillStyle = fill;
  cx.beginPath(); cx.roundRect(x, y, w, h, radius); cx.fill();

  cx.save();
  cx.beginPath(); cx.roundRect(x, y, w, h, radius); cx.clip();
  cx.fillStyle = 'rgba(255,255,255,0.07)';
  cx.fillRect(x, y, w, Math.max(2, h * 0.16));
  cx.restore();

  if (accent) {
    cx.strokeStyle = hexAlpha(accent, 0.5); cx.lineWidth = 1.5;
    cx.beginPath(); cx.roundRect(x + borderWidth + 1.5, y + borderWidth + 1.5, w - (borderWidth+1.5)*2, h - (borderWidth+1.5)*2, Math.max(0, radius - borderWidth)); cx.stroke();
  }

  cx.lineWidth = borderWidth; cx.strokeStyle = border;
  cx.beginPath(); cx.roundRect(x + borderWidth/2, y + borderWidth/2, w - borderWidth, h - borderWidth, Math.max(0, radius - borderWidth/2)); cx.stroke();
  cx.restore();
}

function drawFaultOverlay() {
  if (gState !== 'fault-pause') return;
  cx.fillStyle = 'rgba(0,0,0,0.35)'; cx.fillRect(0, 0, W, H);
  cx.textAlign = 'center';
  cx.fillStyle = '#f0a030'; cx.font = "26px 'Luckiest Guy', cursive";
  cx.fillText('FAULT', W/2, H/2-6);
  cx.fillStyle = '#e8e4da'; cx.font = "11px 'Baloo 2', sans-serif";
  const reason = missType === 'net' ? 'into the net...'
    : missType === 'long' ? 'called long...'
    : missType === 'wide' ? 'called wide...'
    : 'second serve...';
  cx.fillText(reason, W/2, H/2+16);
  cx.textAlign = 'left';
}
function drawPointOverlay() {
  if (gState !== 'point-end') return;
  cx.fillStyle = 'rgba(0,0,0,0.5)'; cx.fillRect(0, 0, W, H);
  cx.textAlign = 'center';
  let title, sub;
  if (gameOverPending) {
    title = ptWin === 'player' ? 'YOU WIN THE GAME!' : `${opponentName} WINS THE GAME!`;
    sub = pointReason === 'double-fault' ? 'on a double fault' : '';
  } else if (pointReason === 'double-fault') {
    title = 'DOUBLE FAULT'; sub = ptWin === 'player' ? 'your point' : `${opponentName.toLowerCase()}'s point`;
  } else {
    title = ptWin === 'player' ? 'YOUR POINT' : `${opponentName}'S POINT`; sub = 'next point incoming...';
  }
  cx.fillStyle = ptWin === 'player' ? '#4ab8f0' : '#f07070';
  cx.font = "24px 'Luckiest Guy', cursive"; cx.fillText(title, W/2, H/2-8);
  cx.fillStyle = '#c8c4b8'; cx.font = "11px 'Baloo 2', sans-serif";
  if (sub) cx.fillText(sub, W/2, H/2+16);
  cx.textAlign = 'left';
}

// A neutral dark background behind the select screen (not tied to any
// single surface's color, since no surface is chosen yet).
function drawCourtSelectBg() {
  cx.fillStyle = '#14261a'; cx.fillRect(0, 0, W, H);
}

// Turns a loadout's raw multipliers into a compact "Power +18%  ·  Reach
// -15%" readout — generic/derived from the actual numbers (rather than
// hand-written per loadout) so retuning LOADOUTS above can never drift out
// of sync with what the select screen displays.
// Word-wraps `text` into fillText() calls starting at (x, y), respecting
// whatever font/align/fillStyle the caller already set. Returns the number
// of lines drawn, so callers can stack the next element right below it
// instead of guessing at a fixed offset.
function wrapText(text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (line && cx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => cx.fillText(l, x, y + i * lineHeight));
  return lines.length;
}

// A small self-contained vignette — a pixel-art character (in the player's
// actual equipped palette, via currentPlayerPalette()) frozen mid-swing on
// this surface's own color/ball, so a court's feel is shown, not just
// described. Reuses drawPerson() exactly as the live match does; the only
// difference is a cx.scale() transform shrinking its whole coordinate space
// down to icon size, so none of the character/racket drawing code needs to
// know or care that it's being rendered small.
function drawMiniSwingPreview(boxX, boxY, boxW, boxH, court, hovered) {
  cx.save();
  cx.beginPath(); cx.rect(boxX, boxY, boxW, boxH); cx.clip();
  cx.fillStyle = court.colorDark;
  cx.fillRect(boxX, boxY, boxW, boxH);
  cx.fillStyle = court.color;
  cx.fillRect(boxX, boxY, boxW, boxH - 9);
  cx.strokeStyle = court.lineColor; cx.lineWidth = 1.5;
  cx.beginPath(); cx.moveTo(boxX, boxY + boxH - 9); cx.lineTo(boxX + boxW, boxY + boxH - 9); cx.stroke();

  cx.save();
  cx.translate(boxX + boxW * 0.46, boxY + boxH - 9);
  cx.scale(0.36, 0.36);
  const hand = drawPerson(currentPlayerPalette(), 0, 0, true, 1, 1, 0);
  cx.fillStyle = court.ballColors.regular;
  cx.beginPath(); cx.arc(hand.handX + 22, hand.handY - 16, 7, 0, Math.PI * 2); cx.fill();
  cx.strokeStyle = 'rgba(0,0,0,0.3)'; cx.lineWidth = 1; cx.stroke();
  cx.restore();

  cx.restore();

  cx.strokeStyle = hovered ? '#ffffff' : 'rgba(255,255,255,0.45)';
  cx.lineWidth = hovered ? 2 : 1;
  cx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
}

function loadoutStatSummary(l) {
  const parts = [];
  [['Speed', l.speedMult], ['Power', l.powerMult], ['Spin', l.spinMult], ['Reach', l.reachMult]].forEach(([label, mult]) => {
    const pct = Math.round((mult - 1) * 100);
    if (pct !== 0) parts.push(`${label} ${pct > 0 ? '+' : ''}${pct}%`);
  });
  return parts.join('   ·   ');
}

function drawLoadoutSelect() {
  drawCourtSelectBg();
  cx.textAlign = 'center';
  cx.fillStyle = '#f0ede4'; cx.font = "24px 'Luckiest Guy', cursive";
  cx.fillText('CHOOSE YOUR RACKET', W/2, 32);
  cx.fillStyle = '#9ab0a0'; cx.font = "10px 'Baloo 2', sans-serif";
  cx.fillText('click a loadout, or press 1 / 2 / 3 / 4', W/2, 50);

  loadoutCardRects = [];
  const cardW = 344, cardH = 110, gap = 8, startY = 64;
  LOADOUT_ORDER.forEach((key, i) => {
    const l = LOADOUTS[key];
    const x = W/2 - cardW/2, y = startY + i*(cardH+gap);
    const rect = { key, x, y, w: cardW, h: cardH };
    loadoutCardRects.push(rect);

    const selected = key === currentLoadout;
    const hovered = hitRect(rect, mouseX, mouseY);
    const accent = LOADOUT_ACCENT[key];

    drawPanel(x, y, cardW, cardH, {
      fill: selected ? '#2f4a35' : hovered ? '#243a29' : '#1f3524',
      border: selected ? '#d8c828' : '#0a1409',
      borderWidth: selected ? 4 : 3,
      accent: accent.c,
    });

    // A real (if tiny) racket, not a flat color swatch — same block-built
    // sprite the live match uses (drawPixelRacket), just laid flat (angle 0)
    // so it centers predictably inside the badge circle, grip-colored with
    // this loadout's own accent so it visually IS the racket you'd be
    // holding, not a decoration next to generic text.
    const iconCX = x + 52, iconCY = y + cardH / 2;
    cx.beginPath(); cx.arc(iconCX, iconCY, 40, 0, Math.PI * 2);
    cx.fillStyle = hexAlpha(accent.c, hovered ? 0.3 : 0.22); cx.fill();
    cx.strokeStyle = accent.c; cx.lineWidth = 1.5; cx.stroke();
    const px = 3.1;
    drawPixelRacket(iconCX - 8 * px, iconCY, 0, accent.d, px);

    // Description column, right of the icon.
    const textX = x + 106, textW = cardW - 118;
    cx.textAlign = 'left';
    cx.fillStyle = '#f0ede4'; cx.font = "17px 'Luckiest Guy', cursive";
    cx.fillText(`${i+1}. ${l.name}`, textX, y + 22);
    cx.fillStyle = '#c8d8c8'; cx.font = "10px 'Baloo 2', sans-serif";
    const blurbLines = wrapText(l.blurb, textX, y + 39, textW, 13);
    const statsY = y + 39 + blurbLines * 13 + 11;
    cx.fillStyle = '#d8c828'; cx.font = "10px 'Baloo 2', sans-serif";
    wrapText(loadoutStatSummary(l) || 'Balanced across the board', textX, statsY, textW, 13);
    if (selected) {
      cx.fillStyle = '#d8c828'; cx.font = "bold 9px 'Baloo 2', sans-serif";
      cx.fillText('CURRENTLY EQUIPPED', textX, y + cardH - 10);
    }
    cx.textAlign = 'center';
  });
  cx.textAlign = 'left';
}

function drawCourtSelect() {
  drawCourtSelectBg();
  cx.textAlign = 'center';
  cx.fillStyle = '#f0ede4'; cx.font = "24px 'Luckiest Guy', cursive";
  cx.fillText('CHOOSE YOUR COURT', W/2, 32);
  cx.fillStyle = '#9ab0a0'; cx.font = "10px 'Baloo 2', sans-serif";
  cx.fillText('click a court, or press 1 / 2 / 3', W/2, 50);

  courtCardRects = [];
  const cardW = 344, cardH = 138, gap = 12;
  const startY = 64;
  COURT_ORDER.forEach((key, i) => {
    const c = COURTS[key];
    const x = W/2 - cardW/2, y = startY + i*(cardH+gap);
    const rect = { key, x, y, w: cardW, h: cardH };
    courtCardRects.push(rect);
    const hovered = hitRect(rect, mouseX, mouseY);

    // card background using the court's own colors so it previews the look
    drawPanel(x, y, cardW, cardH, {
      fill: c.color, border: hovered ? '#ffffff' : '#0a1409',
      borderWidth: hovered ? 4 : 3, accent: c.lineColor,
    });
    cx.save();
    cx.beginPath(); cx.roundRect(x, y, cardW, cardH, 10); cx.clip();
    cx.fillStyle = 'rgba(0,0,0,0.18)';
    cx.fillRect(x, y, cardW, 26);
    if (hovered) { cx.fillStyle = 'rgba(255,255,255,0.08)'; cx.fillRect(x, y, cardW, cardH); }
    cx.restore();

    // Preview vignette on the right — a pixel character actually mid-swing
    // on this surface, not just a description of it.
    const boxW = 96, boxH = cardH - 16, boxX = x + cardW - boxW - 12, boxY = y + 8;
    drawMiniSwingPreview(boxX, boxY, boxW, boxH, c, hovered);

    const textW = cardW - boxW - 36;
    cx.textAlign = 'left';
    cx.fillStyle = c.lineColor; cx.font = "18px 'Luckiest Guy', cursive";
    cx.fillText(`${i+1}. ${c.name}`, x + 12, y + 20);

    cx.fillStyle = '#fff'; cx.font = "10px 'Baloo 2', sans-serif";
    const blurbLines = wrapText(c.blurb, x + 12, y + 38, textW, 13);
    const statsY = y + 38 + blurbLines * 13 + 10;

    // quick stat readout so the differences aren't just flavor text
    const speedPct = Math.round(c.speedMult * 100);
    const spinPct = Math.round(c.spinMult * 100);
    cx.fillStyle = 'rgba(255,255,255,0.9)'; cx.font = "10px 'Baloo 2', sans-serif";
    cx.fillText(`Ball speed: ${speedPct}%`, x + 12, statsY);
    cx.fillText(`Spin grip: ${spinPct}%`, x + 12, statsY + 14);

    // simple bar readouts
    const barW = textW, barX = x + 12;
    cx.fillStyle = 'rgba(0,0,0,0.3)'; cx.fillRect(barX, statsY + 22, barW, 6);
    cx.fillStyle = c.lineColor; cx.fillRect(barX, statsY + 22, barW * Math.min(1, c.speedMult/1.3), 6);
    cx.fillStyle = 'rgba(0,0,0,0.3)'; cx.fillRect(barX, statsY + 34, barW, 6);
    cx.fillStyle = c.lineColor; cx.fillRect(barX, statsY + 34, barW * Math.min(1, c.spinMult/1.4), 6);

    cx.textAlign = 'center';
  });
  cx.textAlign = 'left';
}

function drawTitle() {
  drawCourtSelectBg();
  cx.textAlign = 'center';
  cx.fillStyle = '#f0ede4'; cx.font = "32px 'Luckiest Guy', cursive";
  cx.fillText('TENNIS', W/2, 90);
  cx.fillStyle = '#9ab0a0'; cx.font = "11px 'Baloo 2', sans-serif";
  cx.fillText('choose a mode — click, or press 1 / 2 / C', W/2, 114);

  modeCardRects = [];
  const cardW = 300, cardH = 90, gap = 18, startY = 150;
  const modes = [
    { key: 'exhibition', title: '1. EXHIBITION', blurb: 'Free play — pick a court, rally forever.' },
    { key: 'tournament', title: '2. TOURNAMENT', blurb: 'Win 4 matches in a row to become champion.' },
  ];
  modes.forEach((m, i) => {
    const x = W/2 - cardW/2, y = startY + i*(cardH+gap);
    const rect = { key: m.key, x, y, w: cardW, h: cardH };
    modeCardRects.push(rect);
    const hovered = hitRect(rect, mouseX, mouseY);
    drawPanel(x, y, cardW, cardH, { fill: hovered ? '#26402c' : '#1f3524', border: hovered ? '#d8c828' : '#0a1409', borderWidth: hovered ? 4 : 3 });
    cx.fillStyle = '#f0ede4'; cx.font = "18px 'Luckiest Guy', cursive";
    cx.fillText(m.title, W/2, y + 34);
    cx.fillStyle = '#c8d8c8'; cx.font = "10px 'Baloo 2', sans-serif";
    cx.fillText(m.blurb, W/2, y + 56);
  });

  const btnW = 160, btnH = 34, btnY = startY + modes.length*(cardH+gap) + 6;
  const btnX = W/2 - btnW/2;
  controlsButtonRect = { x: btnX, y: btnY, w: btnW, h: btnH };
  const controlsHovered = hitRect(controlsButtonRect, mouseX, mouseY);
  drawPanel(btnX, btnY, btnW, btnH, { fill: controlsHovered ? '#223022' : '#182219', border: '#0a1409', borderWidth: 3, radius: 8, shadowOffset: 3 });
  cx.fillStyle = '#c8d8c8'; cx.font = "11px 'Baloo 2', sans-serif";
  cx.fillText('C. CONTROLS', W/2, btnY + 22);

  cx.textAlign = 'left';
}

// Shared bracket readout used by all four tournament screens (intro,
// round-win, eliminated) so progress always reads the same way; `subtitle`
// carries the screen-specific instruction/status line under the heading.
function drawTournamentBracket(subtitle) {
  drawCourtSelectBg();
  cx.textAlign = 'center';
  cx.fillStyle = '#f0ede4'; cx.font = "24px 'Luckiest Guy', cursive";
  cx.fillText('TOURNAMENT', W/2, 46);
  cx.fillStyle = '#c8d8c8'; cx.font = "10px 'Baloo 2', sans-serif";
  cx.fillText(subtitle, W/2, 66);

  const cardW = 300, cardH = 54, gap = 10, startY = 92;
  TOURNAMENT_OPPONENTS.forEach((o, i) => {
    const x = W/2 - cardW/2, y = startY + i*(cardH+gap);
    const beaten = i < tournament.round;
    const current = i === tournament.round;
    drawPanel(x, y, cardW, cardH, {
      fill: beaten ? '#1f3524' : current ? '#2f4a35' : '#182219',
      border: current ? '#d8c828' : '#0a1409',
      borderWidth: current ? 4 : 3, radius: 8, shadowOffset: 3,
    });

    cx.textAlign = 'left';
    cx.fillStyle = beaten ? '#7a9a7a' : '#f0ede4'; cx.font = "16px 'Luckiest Guy', cursive";
    cx.fillText(o.round, x + 12, y + 21);
    cx.fillStyle = beaten ? '#5a7a5e' : '#c8d8c8'; cx.font = "11px 'Baloo 2', sans-serif";
    cx.fillText(`vs ${o.name}`, x + 12, y + 40);

    cx.textAlign = 'right';
    cx.fillStyle = beaten ? '#4ab8f0' : current ? '#d8c828' : '#4a5a4a';
    cx.font = "bold 10px 'Baloo 2', sans-serif";
    cx.fillText(beaten ? 'WON' : current ? 'UP NEXT' : '', x + cardW - 12, y + 31);
  });
  cx.textAlign = 'left';
}

function drawTournamentIntro() {
  drawTournamentBracket(`ROUND ${tournament.round + 1} OF ${TOURNAMENT_OPPONENTS.length}, BEST OF 3 — press SPACE or click to play`);
}
function drawTournamentRoundWin() {
  const justBeaten = TOURNAMENT_OPPONENTS[tournament.round - 1].name;
  drawTournamentBracket(
    tournament.round >= TOURNAMENT_OPPONENTS.length
      ? `You beat ${justBeaten} to win it all! Press SPACE...`
      : `You defeated ${justBeaten}! Press SPACE to continue...`
  );
}
function drawTournamentEliminated() {
  const beater = TOURNAMENT_OPPONENTS[tournament.round].name;
  drawTournamentBracket(`Eliminated by ${beater} — SPACE to retry, ESC for menu`);
}
function drawPauseOverlay() {
  cx.fillStyle = 'rgba(0,0,0,0.6)'; cx.fillRect(0, 0, W, H);
  cx.textAlign = 'center';
  cx.fillStyle = '#f0ede4'; cx.font = "30px 'Luckiest Guy', cursive";
  cx.fillText('PAUSED', W/2, H/2 - 10);
  cx.fillStyle = '#9ab0a0'; cx.font = "11px 'Baloo 2', sans-serif";
  cx.fillText('press ESC to resume', W/2, H/2 + 16);

  const btnW = 160, btnH = 34, btnX = W/2 - btnW/2, gap = 10;
  const controlsY = H/2 + 40, quitY = controlsY + btnH + gap;

  pauseControlsRect = { x: btnX, y: controlsY, w: btnW, h: btnH };
  drawPanel(btnX, controlsY, btnW, btnH, { fill: '#182219', border: '#0a1409', borderWidth: 3, radius: 8, shadowOffset: 3, accent: '#5a7a5e' });
  cx.fillStyle = '#c8d8c8'; cx.font = "11px 'Baloo 2', sans-serif";
  cx.fillText('C. CONTROLS', W/2, controlsY + 22);

  pauseQuitRect = { x: btnX, y: quitY, w: btnW, h: btnH };
  drawPanel(btnX, quitY, btnW, btnH, { fill: '#261414', border: '#0a1409', borderWidth: 3, radius: 8, shadowOffset: 3, accent: '#8a4a4a' });
  cx.fillStyle = '#e0a0a0'; cx.font = "11px 'Baloo 2', sans-serif";
  cx.fillText('Q. QUIT TO MENU', W/2, quitY + 22);

  cx.textAlign = 'left';
}

function drawControlsOverlay() {
  cx.fillStyle = 'rgba(0,0,0,0.88)'; cx.fillRect(0, 0, W, H);
  cx.textAlign = 'center';
  cx.fillStyle = '#f0ede4'; cx.font = "24px 'Luckiest Guy', cursive";
  cx.fillText('CONTROLS', W/2, 42);

  const lines = [
    'MOVE: ARROWS / WASD',
    'AIM SERVE: ARROWS / WASD',
    '(corners = harder + faster serve)',
    'SPACE in the zone = serve in',
    'SPACE in the orange window = POWER SERVE',
    'HOLD SHIFT = power shot',
    'HOLD X = slice   ·   HOLD Z = lob (beats a net rusher)',
    'HOLD V = drop shot (beats a baseline camper)',
    'Miss the zone = fault, miss twice = double fault',
    'ESC = pause',
  ];
  cx.font = "11px 'Baloo 2', sans-serif";
  let y = 82;
  for (const line of lines) {
    cx.fillStyle = '#e8e4da';
    cx.fillText(line, W/2, y);
    y += 24;
  }

  cx.fillStyle = '#9ab0a0'; cx.font = "10px 'Baloo 2', sans-serif";
  cx.fillText('click, or press C / ESC / SPACE to close', W/2, y + 12);
  cx.textAlign = 'left';
}

function drawTournamentChampion() {
  drawCourtSelectBg();
  cx.textAlign = 'center';
  cx.fillStyle = '#d8c828'; cx.font = "30px 'Luckiest Guy', cursive";
  cx.fillText('CHAMPION!', W/2, H/2 - 20);
  cx.fillStyle = '#f0ede4'; cx.font = "12px 'Baloo 2', sans-serif";
  cx.fillText('You beat all 4 opponents.', W/2, H/2 + 8);
  cx.fillStyle = '#9ab0a0'; cx.font = "10px 'Baloo 2', sans-serif";
  cx.fillText('press SPACE or click to return to the menu', W/2, H/2 + 30);
  cx.textAlign = 'left';
}

function draw() {
  // No early returns here — showControls/paused need to overlay on top of
  // whichever screen below actually rendered, title screen included.
  if (gState === 'title') { drawTitle(); }
  else if (gState === 'tournament-intro') { drawTournamentIntro(); }
  else if (gState === 'tournament-round-win') { drawTournamentRoundWin(); }
  else if (gState === 'tournament-eliminated') { drawTournamentEliminated(); }
  else if (gState === 'tournament-champion') { drawTournamentChampion(); }
  else if (gState === 'loadout-select') { drawLoadoutSelect(); }
  else if (gState === 'court-select') { drawCourtSelect(); }
  else {
    drawCourt();
    drawServiceMarkers();
    drawTopBanner();
    drawAimCrosshair();
    drawCharacter(ai, PAL_A, false);
    drawCharacter(player, currentPlayerPalette(), true);
    drawTossBall();
    drawBall();
    drawShotLabel();
    drawServeBar();
    drawFaultOverlay();
    drawPointOverlay();
  }
  if (paused) drawPauseOverlay();
  if (showControls) drawControlsOverlay();
}

function loop() { update(); draw(); requestAnimationFrame(loop); }

loop(); // the loop starts immediately, showing the court-select screen;
        // beginPoint() (and the match itself) only fires once selectCourt()
        // is called from a click or 1/2/3 keypress.
