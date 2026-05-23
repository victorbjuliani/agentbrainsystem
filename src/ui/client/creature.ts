/**
 * The creature renderer (ADR-0015) — the hero of the UI (DESIGN §0, §11).
 *
 * Replaces the force-graph node-link paint with a bioluminescent jellyfish whose
 * anatomy encodes the memory: the dome is the consolidated core + a neural mesh
 * of similarity, each tentacle is a session (a chronological thread), each bead
 * of light is an observation (coloured by `kind`), brightness is recency, and the
 * most-recent observations pulse (the live "delta"). WebGL2 + HDR bloom + ACES
 * tone mapping (the modern look validated by the killer test). All ambient motion
 * is gated behind prefers-reduced-motion.
 *
 * It is a drop-in for the retired `render.ts`: same `createRenderer(mount, cb)`
 * and same `Renderer` interface, driven by `setData(ViewGraph)` — so `main.ts`
 * (scope, filters, search, selection, theme, delete) is unchanged.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { NodeType } from '../graph-types.js';
import { beadParam, recencyNorm, tentacleAngle, tentacleLength } from './creature-geometry.js';
import { colorForType } from './palette.js';
import type { ViewGraph, ViewNode } from './types.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const BELL_Y = 2.05;
const BELL_R = 2.25;

export interface RendererCallbacks {
  onSelect(node: ViewNode | null): void;
}

export interface Renderer {
  setData(graph: ViewGraph): void;
  setVisibleTypes(types: Set<NodeType>): void;
  select(node: ViewNode | null): void;
  refreshTheme(): void;
  fit(): void;
  resize(w: number, h: number): void;
}

/** Thrown by `createRenderer` when the browser has no WebGL2 context (ADR-0015).
 *  `main.ts` catches this to paint an on-brand fallback instead of a black canvas. */
export class CreatureUnsupportedError extends Error {
  constructor() {
    super('WebGL2 is not available in this browser');
    this.name = 'CreatureUnsupportedError';
  }
}

/** Probe WebGL2 on a throwaway canvas so we never leave a dead context on the mount. */
function webgl2Supported(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

/** Stable per-edge endpoint id (edges arrive as wire string ids). */
function endpointId(end: string | ViewNode): string {
  return typeof end === 'string' ? end : end.id;
}

/** A soft radial sprite used for the core, halo, and (optionally) glow. */
function glowTexture(): THREE.Texture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  if (g) {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.22, 'rgba(255,255,255,0.8)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }
  return new THREE.CanvasTexture(cv);
}

interface Tentacle {
  session: ViewNode;
  baseX: number;
  baseZ: number;
  len: number;
  phase: number;
  freq: number;
  amp: number;
}

interface Bead {
  node: ViewNode;
  tentacle: Tentacle;
  p: number;
  rec: number;
  active: boolean;
}

export function createRenderer(mount: HTMLElement, cb: RendererCallbacks): Renderer {
  if (!webgl2Supported()) throw new CreatureUnsupportedError();

  // Theme drives the elevation model (DESIGN §8): dark = additive bioluminescence
  // (glow + bloom); light = translucent pastel gel with a soft diffuse shadow and
  // near-zero bloom, so the creature reads on a pale canvas instead of washing out.
  let isLight = document.documentElement.dataset.theme === 'light';

  // --- renderer / scene / camera / composer (HDR bloom + ACES) ----------------
  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.display = 'block';
  mount.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);

  const composer = new EffectComposer(renderer);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.62, 0.55, 0.34);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Free exploration (DESIGN §11 "zoom/pan livres"): scroll = zoom, drag = orbit,
  // right-drag = pan. Damping for the organic feel; clamped so you can't fly away
  // or invert under the creature. Listens on the canvas so the overlays stay clickable.
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, -0.9, 0);
  controls.enableDamping = !REDUCED_MOTION;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 4;
  controls.maxDistance = 32;
  controls.maxPolarAngle = Math.PI * 0.92;
  // Under reduced motion the rAF loop is off, so repaint on each control change.
  if (REDUCED_MOTION) controls.addEventListener('change', () => frame(performance.now()));

  const GLOW = glowTexture();
  const root = new THREE.Group();
  scene.add(root);

  // --- static bell: dome shell + inner gel + halo + hot core (DESIGN §11) -----
  const bellUniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0x8b5cf6) },
    uLight: { value: isLight ? 1 : 0 },
  };
  const bellMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    uniforms: bellUniforms,
    vertexShader: `
      uniform float uTime;
      varying vec3 vN; varying vec3 vView; varying vec3 vPos;
      void main(){
        float ang0 = atan(position.z, position.x);
        float rimMask = smoothstep(0.3, -0.45, position.y);
        float frill = sin(ang0*9.0 + uTime*0.5)*0.5 + 0.5; frill *= frill;
        vec3 outward = normalize(vec3(position.x, 0.0, position.z) + 1e-4);
        vec3 p = position + outward * frill * rimMask * 0.28;
        p.y -= frill * rimMask * 0.32;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(p,1.0);
        vView = normalize(-mv.xyz); vPos = p;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uLight;
      varying vec3 vN; varying vec3 vView; varying vec3 vPos;
      void main(){
        float fres = pow(1.0 - max(dot(vN, vView), 0.0), 3.0);
        float ang = atan(vPos.z, vPos.x);
        float ribs = 0.5 + 0.5*sin(ang*46.0); ribs = pow(ribs, 5.0);
        float lowBand = smoothstep(${(BELL_R * 0.55).toFixed(2)}, -0.6, vPos.y);
        float sss = smoothstep(1.5, 0.0, length(vPos.xz)) * smoothstep(0.6, -1.0, vPos.y);
        if (uLight > 0.5) {
          // Light: translucent pastel gel (DESIGN §8) — fresnel-dense rim so the
          // silhouette reads on white; normal blending (set on the material).
          vec3 gel = mix(vec3(0.66,0.60,0.86), uColor*0.55, 0.45);
          float ga = clamp(fres*0.55 + ribs*0.05*lowBand + sss*0.20 + 0.05, 0.0, 0.82);
          gl_FragColor = vec4(gel, ga);
        } else {
          float a = fres*0.7 + ribs*0.12*lowBand + sss*0.18 + 0.010;
          vec3 col = uColor*(0.22 + fres*0.62) + vec3(0.14,0.09,0.26)*ribs*lowBand + uColor*sss*0.5;
          gl_FragColor = vec4(col, a*0.42);
        }
      }`,
  });
  const bell = new THREE.Mesh(
    new THREE.SphereGeometry(BELL_R, 128, 80, 0, Math.PI * 2, 0, Math.PI * 0.6),
    bellMat,
  );
  bell.position.y = BELL_Y;
  root.add(bell);

  const inner = new THREE.Mesh(
    new THREE.SphereGeometry(BELL_R * 0.82, 64, 48, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.MeshBasicMaterial({
      color: 0x6d4fd0,
      transparent: true,
      opacity: 0.06,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    }),
  );
  inner.position.y = BELL_Y;
  root.add(inner);

  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: GLOW,
      color: 0x6e4fd8,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  halo.scale.set(8, 8, 1);
  halo.position.set(0, BELL_Y - 0.3, -0.6);
  root.add(halo);

  const core = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: GLOW,
      color: 0xe6dcff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  core.scale.set(0.8, 0.8, 1);
  core.position.set(0, BELL_Y - 0.6, 0.15);
  root.add(core);

  // Soft diffuse shadow under the creature — light mode only (DESIGN §8: "sombra
  // difusa sob ele"). A dark radial sprite with normal blending; hidden in dark
  // (glow is the elevation there, not shadow). Sits behind/below the bell.
  const shadow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: GLOW,
      color: 0x14101b,
      transparent: true,
      opacity: 0,
      blending: THREE.NormalBlending,
      depthWrite: false,
    }),
  );
  shadow.scale.set(7.5, 4.2, 1);
  shadow.position.set(0, BELL_Y - 3.4, -1.2);
  root.add(shadow);

  // Glow sprites are additive; on a pale canvas they read as white blobs, so light
  // mode dims them to nothing and leans on the gel bell + shadow instead.
  function applySpriteTheme(): void {
    halo.material.opacity = isLight ? 0 : 0.18;
    core.material.opacity = isLight ? 0 : 1;
    (inner.material as THREE.MeshBasicMaterial).opacity = isLight ? 0 : 0.06;
    shadow.material.opacity = isLight ? 0.22 : 0;
  }
  applySpriteTheme();

  // --- data-driven layers (rebuilt on setData) --------------------------------
  let data: ViewGraph = { nodes: [], links: [] };
  let visibleTypes: Set<NodeType> | null = null;
  let selectedId: string | null = null;

  let tentacles: Tentacle[] = [];
  let beads: Bead[] = [];
  // Tentacle threads (one Line each) and the dome neural mesh, disposed per rebuild.
  const dynamic: THREE.Object3D[] = [];
  const SEG = 64;
  const tentacleLines: { tentacle: Tentacle; posAttr: THREE.BufferAttribute }[] = [];

  // Tentacle + neural-mesh line materials are rebuilt per setData, so they carry the
  // theme too: additive luminous violet in dark, deeper opaque violet on white (§8).
  interface ThemedLine {
    mat: THREE.LineBasicMaterial;
    role: 'tentacle' | 'mesh';
    baseOp: number;
  }
  let themedLines: ThemedLine[] = [];
  function styleLine(t: ThemedLine): void {
    if (isLight) {
      t.mat.blending = THREE.NormalBlending;
      t.mat.color.set(t.role === 'mesh' ? 0x8b78d8 : 0x6d4fd0);
      t.mat.opacity = t.role === 'mesh' ? 0.3 : Math.min(0.6, t.baseOp + 0.28);
    } else {
      t.mat.blending = THREE.AdditiveBlending;
      t.mat.color.set(t.role === 'mesh' ? 0xc9bbff : 0x9b7cf0);
      t.mat.opacity = t.role === 'mesh' ? 0.18 : t.baseOp;
    }
    t.mat.needsUpdate = true;
  }

  // Beads as one additive Points cloud (HDR colours feed the bloom).
  let beadGeo: THREE.BufferGeometry | null = null;
  let beadPos = new Float32Array(0);
  let beadBaseCol = new Float32Array(0); // per-bead kind colour (linear, pre-intensity)
  let beadColAttr = new Float32Array(0); // live colour * intensity (updated per frame)
  let beadSizeAttr = new Float32Array(0);
  let beadPosBA: THREE.BufferAttribute | null = null;
  let beadColBA: THREE.BufferAttribute | null = null;
  let beadSizeBA: THREE.BufferAttribute | null = null;

  const beadUniforms = {
    uPix: { value: renderer.getPixelRatio() },
    uLight: { value: isLight ? 1 : 0 },
  };
  const beadMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    uniforms: beadUniforms,
    vertexShader: `
      attribute float aSize;
      varying vec3 vC; uniform float uPix;
      void main(){
        vC = color;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = aSize * uPix * (10.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vC;
      uniform float uLight;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        if (uLight > 0.5) {
          // Light: solid pastel pigment dot (DESIGN §8) — deepen the kind colour so
          // it reads on white, with a low-alpha bloom-ish halo for the "acender".
          vec3 pig = clamp(vC, 0.0, 1.0) * 0.62;
          float core = smoothstep(0.42, 0.06, d);
          float halo = smoothstep(0.5, 0.30, d) * 0.35;
          gl_FragColor = vec4(pig, max(core, halo));
        } else {
          float a = smoothstep(0.5, 0.04, d);
          float hot = smoothstep(0.28, 0.0, d);
          vec3 col = mix(vC, vC + vec3(0.6), hot*0.45);
          gl_FragColor = vec4(col, a);
        }
      }`,
    vertexColors: true,
  });
  const beadPoints = new THREE.Points(new THREE.BufferGeometry(), beadMat);
  root.add(beadPoints);

  function disposeDynamic(): void {
    for (const o of dynamic) {
      root.remove(o);
      if (o instanceof THREE.Line || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    }
    dynamic.length = 0;
    tentacleLines.length = 0;
    themedLines = [];
  }

  /** Position of point `u` (0=bell, 1=tip) on tentacle `T` at time `time`. */
  function tentaclePoint(T: Tentacle, u: number, time: number, out: THREE.Vector3): THREE.Vector3 {
    const sway = Math.sin(time * T.freq + T.phase + u * 4.2) * T.amp * u;
    const sway2 = Math.cos(time * T.freq * 0.7 + T.phase * 1.3 + u * 2.8) * T.amp * 0.55 * u;
    return out.set(T.baseX + sway, BELL_Y - 0.5 - u * T.len - u * u * 0.5, T.baseZ + sway2);
  }

  function rebuild(): void {
    disposeDynamic();
    tentacles = [];
    beads = [];

    const sessions = data.nodes.filter((n) => n.type === 'session');
    const obs = data.nodes.filter((n) => n.type !== 'session');

    // Group observations by their owning session (sessionId is `s:<id>`).
    const bySession = new Map<string, ViewNode[]>();
    for (const s of sessions) bySession.set(s.id, []);
    for (const o of obs) {
      const sid = o.sessionId;
      if (sid && bySession.has(sid)) bySession.get(sid)?.push(o);
    }

    // Recency window over all observations (drives bead brightness/position).
    const times = obs.map((o) => Date.parse(o.createdAt) || 0);
    const tMin = times.length ? Math.min(...times) : 0;
    const tMax = times.length ? Math.max(...times) : 0;
    const recent = obs
      .slice()
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
      .slice(0, 12);
    const activeSet = new Set(recent.map((o) => o.id));

    // One tentacle per session, ordered by size so big sessions get stable angles.
    const ordered = sessions.slice().sort((a, b) => b.sizeDriver - a.sizeDriver);
    const n = ordered.length || 1;
    ordered.forEach((s, i) => {
      const list = (bySession.get(s.id) ?? [])
        .slice()
        .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      const count = list.length;
      const ang = tentacleAngle(i, n);
      const spread = 0.35 + (i % 2) * 0.28;
      const T: Tentacle = {
        session: s,
        baseX: Math.cos(ang) * BELL_R * 0.78 * spread,
        baseZ: Math.sin(ang) * BELL_R * 0.78 * spread,
        len: tentacleLength(count),
        phase: i * 1.7,
        freq: 0.42 + (i % 3) * 0.1,
        amp: 0.6 + spread * 0.7,
      };
      tentacles.push(T);

      const op = 0.1 + Math.min(0.26, count / 600);
      const posBA = new THREE.Float32BufferAttribute(new Float32Array((SEG + 1) * 3), 3);
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', posBA);
      const lineMat = new THREE.LineBasicMaterial({
        transparent: true,
        depthWrite: false,
      });
      const tentLine: ThemedLine = { mat: lineMat, role: 'tentacle', baseOp: op };
      styleLine(tentLine);
      themedLines.push(tentLine);
      const line = new THREE.Line(lineGeo, lineMat);
      root.add(line);
      dynamic.push(line);
      tentacleLines.push({ tentacle: T, posAttr: posBA });

      list.forEach((o, idx) => {
        beads.push({
          node: o,
          tentacle: T,
          p: beadParam(idx, count),
          rec: recencyNorm(Date.parse(o.createdAt) || 0, tMin, tMax),
          active: activeSet.has(o.id),
        });
      });
    });

    // Dome neural mesh: similarity edges among the highest-degree observations.
    const simDeg = new Map<string, number>();
    for (const e of data.links) {
      if (e.kind !== 'similarity') continue;
      const s = endpointId(e.source);
      const t = endpointId(e.target);
      simDeg.set(s, (simDeg.get(s) ?? 0) + 1);
      simDeg.set(t, (simDeg.get(t) ?? 0) + 1);
    }
    const meshNodes = obs
      .slice()
      .sort((a, b) => (simDeg.get(b.id) ?? 0) - (simDeg.get(a.id) ?? 0))
      .slice(0, 50);
    const meshPos = new Map<string, THREE.Vector3>();
    meshNodes.forEach((o, i) => {
      const t = (i + 0.5) / meshNodes.length;
      const phi = Math.acos(1 - t * 0.92);
      const theta = i * 2.399963;
      const r = BELL_R * 0.99;
      meshPos.set(
        o.id,
        new THREE.Vector3(
          r * Math.sin(phi) * Math.cos(theta),
          BELL_Y + r * Math.cos(phi) * 0.6,
          r * Math.sin(phi) * Math.sin(theta),
        ),
      );
    });
    const meshVerts: number[] = [];
    const meshSet = new Set(meshNodes.map((o) => o.id));
    for (const e of data.links) {
      if (e.kind !== 'similarity') continue;
      const a = meshPos.get(endpointId(e.source));
      const b = meshPos.get(endpointId(e.target));
      if (a && b && meshSet.has(endpointId(e.source)) && meshSet.has(endpointId(e.target))) {
        meshVerts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    if (meshVerts.length) {
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.Float32BufferAttribute(meshVerts, 3));
      const meshMat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
      const meshLine: ThemedLine = { mat: meshMat, role: 'mesh', baseOp: 0.18 };
      styleLine(meshLine);
      themedLines.push(meshLine);
      const mesh = new THREE.LineSegments(mg, meshMat);
      root.add(mesh);
      dynamic.push(mesh);
    }

    // Bead buffers.
    const N = beads.length;
    beadPos = new Float32Array(N * 3);
    beadBaseCol = new Float32Array(N * 3);
    beadColAttr = new Float32Array(N * 3);
    beadSizeAttr = new Float32Array(N);
    const tmpc = new THREE.Color();
    beads.forEach((b, i) => {
      tmpc.set(colorForType(b.node.type));
      beadBaseCol[i * 3] = tmpc.r;
      beadBaseCol[i * 3 + 1] = tmpc.g;
      beadBaseCol[i * 3 + 2] = tmpc.b;
      beadSizeAttr[i] = (b.active ? 9 : 4.5) + b.rec * 4;
    });
    beadPosBA = new THREE.BufferAttribute(beadPos, 3);
    beadColBA = new THREE.BufferAttribute(beadColAttr, 3);
    beadSizeBA = new THREE.BufferAttribute(beadSizeAttr, 1);
    beadGeo = new THREE.BufferGeometry();
    beadGeo.setAttribute('position', beadPosBA);
    beadGeo.setAttribute('color', beadColBA);
    beadGeo.setAttribute('aSize', beadSizeBA);
    beadPoints.geometry.dispose();
    beadPoints.geometry = beadGeo;

    applyVisibility();
  }

  /** Hidden-type beads collapse to size 0 (the type-filter pills). */
  function applyVisibility(): void {
    if (!beadSizeBA) return;
    beads.forEach((b, i) => {
      const visible = visibleTypes === null || visibleTypes.has(b.node.type);
      const base = (b.active ? 9 : 4.5) + b.rec * 4;
      beadSizeAttr[i] = visible ? base : 0;
    });
    beadSizeBA.needsUpdate = true;
  }

  // --- picking: nearest projected bead, else nearest tentacle (session) -------
  const proj = new THREE.Vector3();
  function pickAt(clientX: number, clientY: number): ViewNode | null {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best: ViewNode | null = null;
    let bestDist = 20; // bead hit radius (px)
    const toScreen = (v: THREE.Vector3): { x: number; y: number; behind: boolean } => {
      proj.copy(v).project(camera);
      return {
        x: ((proj.x + 1) / 2) * rect.width,
        y: ((1 - proj.y) / 2) * rect.height,
        behind: proj.z > 1,
      };
    };
    // beads (observations) first — tight radius
    const tmp = new THREE.Vector3();
    beads.forEach((b, i) => {
      if ((beadSizeAttr[i] ?? 0) === 0) return; // hidden by type filter
      tmp.set(beadPos[i * 3] ?? 0, beadPos[i * 3 + 1] ?? 0, beadPos[i * 3 + 2] ?? 0);
      const s = toScreen(tmp);
      if (s.behind) return;
      const d = Math.hypot(s.x - px, s.y - py);
      if (d < bestDist) {
        bestDist = d;
        best = b.node;
      }
    });
    if (best) return best;
    // else nearest tentacle (session) along sampled points — wider radius
    let sessDist = 34;
    for (const T of tentacleLines) {
      for (const u of [0.18, 0.42, 0.66]) {
        tentaclePoint(T.tentacle, u, lastTime, tmp);
        const s = toScreen(tmp);
        if (s.behind) continue;
        const d = Math.hypot(s.x - px, s.y - py);
        if (d < sessDist) {
          sessDist = d;
          best = T.tentacle.session;
        }
      }
    }
    return best;
  }

  canvas.addEventListener('click', (ev) => {
    const node = pickAt(ev.clientX, ev.clientY);
    selectedId = node ? node.id : null;
    cb.onSelect(node);
  });
  canvas.addEventListener('pointermove', (ev) => {
    canvas.style.cursor = pickAt(ev.clientX, ev.clientY) ? 'pointer' : 'default';
  });

  // --- camera framing ---------------------------------------------------------
  let framedOnce = false;
  function frameCamera(force = false): void {
    // The creature spans roughly y ∈ [-7, 4.3]; frame it for the current aspect.
    // Once framed, OrbitControls owns the camera — only a forced fit re-centres it
    // (so a window resize never yanks the view out from under the user).
    controls.target.set(0, -0.9, 0);
    if (framedOnce && !force) {
      controls.update();
      return;
    }
    const halfH = 5.7;
    const vFovFit = halfH / Math.tan((camera.fov * Math.PI) / 360);
    const hFovFit = halfH / camera.aspect / Math.tan((camera.fov * Math.PI) / 360);
    const dist = Math.max(vFovFit, hFovFit) * 1.04;
    camera.position.set(0, -0.85, dist);
    controls.update();
    framedOnce = true;
  }

  // --- animation loop ---------------------------------------------------------
  const tmp = new THREE.Vector3();
  let lastTime = 0;
  let raf = 0;
  const t0 = performance.now();
  function frame(now: number): void {
    const time = REDUCED_MOTION ? 0 : (now - t0) / 1000;
    lastTime = time;
    controls.update();

    const breath = 1 + Math.sin(time * 0.8) * 0.022;
    bell.scale.set(breath, 1 / Math.sqrt(breath), breath);
    inner.scale.copy(bell.scale);
    root.position.y = Math.sin(time * 0.5) * 0.1;
    const cp = 0.8 + Math.sin(time * 1.5) * 0.2;
    core.scale.set(0.8 * cp, 0.8 * cp, 1);
    bellUniforms.uTime.value = time;

    for (const { tentacle, posAttr } of tentacleLines) {
      const arr = posAttr.array as Float32Array;
      for (let k = 0; k <= SEG; k++) {
        tentaclePoint(tentacle, k / SEG, time, tmp);
        arr[k * 3] = tmp.x;
        arr[k * 3 + 1] = tmp.y;
        arr[k * 3 + 2] = tmp.z;
      }
      posAttr.needsUpdate = true;
    }

    if (beadPosBA && beadColBA) {
      beads.forEach((b, i) => {
        tentaclePoint(b.tentacle, b.p, time, tmp);
        beadPos[i * 3] = tmp.x;
        beadPos[i * 3 + 1] = tmp.y;
        beadPos[i * 3 + 2] = tmp.z;
        // Intensity: HDR feeds bloom; recent observations pulse; selection burns brightest.
        const selected = selectedId !== null && b.node.id === selectedId;
        let inten = 1 + b.rec * 0.7;
        if (b.active) inten = 2.1 + (REDUCED_MOTION ? 0 : Math.sin(time * 3 + b.p * 6) * 0.5);
        if (selected) inten = 3.2;
        beadColAttr[i * 3] = (beadBaseCol[i * 3] ?? 0) * inten;
        beadColAttr[i * 3 + 1] = (beadBaseCol[i * 3 + 1] ?? 0) * inten;
        beadColAttr[i * 3 + 2] = (beadBaseCol[i * 3 + 2] ?? 0) * inten;
      });
      beadPosBA.needsUpdate = true;
      beadColBA.needsUpdate = true;
    }

    composer.render();
    if (!REDUCED_MOTION) raf = requestAnimationFrame(frame);
  }
  function start(): void {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  return {
    setData(next: ViewGraph): void {
      data = next;
      selectedId = null;
      rebuild();
      start();
      if (REDUCED_MOTION) frame(performance.now()); // one static paint
    },
    setVisibleTypes(types: Set<NodeType>): void {
      visibleTypes = types;
      applyVisibility();
      if (REDUCED_MOTION) frame(performance.now());
    },
    select(node: ViewNode | null): void {
      selectedId = node ? node.id : null;
      if (REDUCED_MOTION) frame(performance.now());
    },
    refreshTheme(): void {
      // Swap the whole elevation model (DESIGN §8). Additive glow + bloom wash out on
      // white, so light mode flips bell/beads/lines to normal blending with pigment
      // colours, kills the bloom, and turns on the diffuse shadow.
      isLight = document.documentElement.dataset.theme === 'light';
      renderer.toneMappingExposure = isLight ? 0.92 : 0.98;
      bloom.strength = isLight ? 0.16 : 0.62;
      bellUniforms.uLight.value = isLight ? 1 : 0;
      bellMat.blending = isLight ? THREE.NormalBlending : THREE.AdditiveBlending;
      bellMat.needsUpdate = true;
      beadUniforms.uLight.value = isLight ? 1 : 0;
      beadMat.blending = isLight ? THREE.NormalBlending : THREE.AdditiveBlending;
      beadMat.needsUpdate = true;
      applySpriteTheme();
      for (const t of themedLines) styleLine(t);
      if (REDUCED_MOTION) frame(performance.now());
    },
    fit(): void {
      frameCamera(true);
    },
    resize(w: number, h: number): void {
      renderer.setSize(w, h);
      composer.setSize(w, h);
      bloom.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      frameCamera();
      if (REDUCED_MOTION) frame(performance.now());
    },
  };
}
