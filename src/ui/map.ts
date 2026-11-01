import { EDGE_LIST, REGION_DEFS, isSea } from "../data/regions";
import { FACTION_INFO } from "../data/scenarios";
import type { GameState } from "../engine/types";
import { strategicMapImg } from "./assets";

export const MAP_W = 640;
export const MAP_H = 680;

// 구간별 투영: 중원(경도 120 이서)과 만주(위도 40 이북)는 압축하고 한반도는 크게 그린다
export function project(lon: number, lat: number): [number, number] {
  const x = lon < 120 ? (lon - 114.5) * 20 : 110 + (lon - 120) * 48;
  const y = lat > 40 ? (43.5 - lat) * 50 : 175 + (40 - lat) * 72;
  return [Math.round(x), Math.round(y)];
}

// 대륙·한반도 해안선 (대략)
const COAST: [number, number][] = [
  [114.5, 43.5], [132, 43.5], [132, 43.0], [131.2, 42.6], [130.7, 42.3], [130.4, 42.2], [129.9, 41.9], [129.7, 41.4],
  [129.4, 40.9], [129.0, 40.6], [128.6, 40.3], [128.0, 40.0], [127.6, 39.75], [127.45, 39.4], [127.55, 39.15], [127.9, 38.85],
  [128.35, 38.45], [128.6, 38.15], [128.95, 37.7], [129.25, 37.3], [129.4, 36.8], [129.45, 36.4], [129.6, 36.05], [129.45, 35.65],
  [129.35, 35.35], [129.1, 35.1], [128.75, 35.0], [128.4, 34.85], [128.0, 34.85], [127.7, 34.75], [127.4, 34.6], [127.1, 34.5],
  [126.75, 34.35], [126.35, 34.35], [126.3, 34.7], [126.45, 35.0], [126.4, 35.4], [126.6, 35.75], [126.65, 36.0], [126.5, 36.3],
  [126.15, 36.65], [126.35, 36.85], [126.8, 36.95], [126.65, 37.2], [126.55, 37.5], [126.2, 37.75], [125.75, 37.85], [125.3, 37.75],
  [125.0, 37.95], [125.15, 38.3], [124.85, 38.55], [125.25, 38.75], [125.45, 39.2], [125.3, 39.55], [124.75, 39.65], [124.3, 39.85],
  [123.6, 39.75], [122.9, 39.55], [122.3, 39.25], [121.65, 38.85], [121.2, 38.75], [121.3, 39.1], [121.55, 39.45], [121.75, 39.85],
  [122.1, 40.35], [122.2, 40.65], [121.9, 40.95], [121.4, 40.9], [121.0, 40.75], [120.6, 40.35], [119.8, 39.95], [119.2, 39.4],
  [118.5, 39.1], [117.7, 38.95], [117.55, 38.5], [118.2, 38.1], [118.9, 37.75], [119.4, 37.15], [119.9, 37.25], [120.4, 37.55],
  [120.8, 37.8], [121.4, 37.55], [122.1, 37.5], [122.6, 37.4], [122.45, 36.95], [121.6, 36.75], [120.7, 36.35], [120.3, 36.0],
  [119.6, 35.5], [119.35, 34.85], [119.8, 34.45], [120.4, 33.8], [120.6, 33.0], [114.5, 33.0],
];

const pathOf = (pts: [number, number][]) =>
  "M" + pts.map(([lo, la]) => project(lo, la).join(",")).join(" L") + " Z";

const SVG_NS = "http://www.w3.org/2000/svg";

// 손가락으로 조작하는 화면인가
export const touchScreen = () => window.matchMedia("(max-width: 860px), (pointer: coarse)").matches;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const HANJA: Record<string, string> = { goguryeo: "高句麗", baekje: "百濟", silla: "新羅", tang: "唐" };

export class MapView {
  private selectable?: number[];
  private nodes = new Map<number, SVGGElement>();
  private territory: SVGImageElement;
  private labels: SVGGElement;
  private legend: SVGGElement;
  private ground: SVGGElement;
  private pins = new Map<SVGElement, [number, number]>(); // 그림은 늘려도 점과 글자는 모양을 지킨다: 위치만 옮긴다
  private lines: [SVGLineElement, number, number][] = [];
  private stretch = 1; // 지도를 화면 너비에 맞추려고 가로로 늘린 배율
  private territoryKey = "";
  onClick: (id: number) => void = () => {};

  constructor(private svg: SVGSVGElement) {
    svg.addEventListener("click", (e) => this.tap(e));
    this.ground = el("g", {});
    svg.append(this.ground);
    this.ground.append(el("rect", { x: 0, y: 0, width: MAP_W, height: MAP_H, class: "sea" }));
    this.ground.append(el("path", { d: pathOf(COAST), class: "land" }));
    // 제주
    const [jx, jy] = project(126.55, 33.38);
    this.ground.append(el("ellipse", { cx: jx, cy: jy, rx: 13, ry: 8, class: "land" }));
    // Codex로 그린 지도 그림 (해안선 기준 이미지를 바탕으로 그려 좌표가 맞는다). 없으면 위의 단색 지도가 보인다.
    const paint = el("image", { href: strategicMapImg, x: 0, y: 0, width: MAP_W, height: MAP_H, preserveAspectRatio: "none", class: "painted" });
    paint.addEventListener("error", () => paint.remove(), { once: true });
    this.ground.append(paint);
    // 세력 영역: 각 지점을 가장 가까운 지역의 세력 색으로 칠한다 (육지로 잘라냄)
    const defs = el("defs", {});
    const clip = el("clipPath", { id: "land-clip" });
    clip.append(el("path", { d: pathOf(COAST) }));
    defs.append(clip);
    this.ground.append(defs);
    this.territory = el("image", { x: 0, y: 0, width: MAP_W, height: MAP_H, preserveAspectRatio: "none", "clip-path": "url(#land-clip)", class: "territory" });
    this.ground.append(this.territory);
    this.labels = el("g", { class: "realm-labels" });
    this.legend = el("g", { class: "legend" });
    // 중원 표시
    const [cx, cy] = project(114.6, 36.4);
    const note = el("g", {});
    const t = el("text", { class: "map-note" });
    t.textContent = "← 중원";
    note.append(t);
    this.pins.set(note, [cx + 4, cy]);
    svg.append(note);

    const edges = el("g", { class: "edges" });
    for (const [a, b] of EDGE_LIST) {
      const A = REGION_DEFS[a - 1];
      const B = REGION_DEFS[b - 1];
      const [x1, y1] = project(A.lon, A.lat);
      const [x2, y2] = project(B.lon, B.lat);
      const line = el("line", { x1, y1, x2, y2, class: isSea(a, b) ? "edge sea-edge" : "edge" });
      this.lines.push([line, x1, x2]);
      edges.append(line);
    }
    svg.append(edges, this.labels, this.legend);

    for (const d of REGION_DEFS) {
      const [x, y] = project(d.lon, d.lat);
      const g = el("g", { class: "node", tabindex: 0, role: "button" });
      this.pins.set(g, [x, y]);
      g.setAttribute("aria-label", `${d.id} ${d.name}`);
      g.append(el("circle", { r: 15, class: "hit" }));
      g.append(el("circle", { r: 10, class: "dot" }));
      // 공방전이 이어지는 곳: 붉은 고리와 교차한 칼
      const siege = el("g", { class: "siege" });
      siege.append(el("circle", { r: 14, class: "siege-ring" }));
      siege.append(el("path", { d: "M7 -21 L17 -11 M17 -21 L7 -11", class: "siege-swords" }));
      g.append(siege);
      const num = el("text", { y: 3.5, class: "num" });
      num.textContent = String(d.id);
      g.append(num);
      const label = el("text", { y: 22, class: "label" });
      label.textContent = d.name;
      g.append(label);
      g.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") {
          e.stopPropagation();
          this.onClick(d.id);
        }
      });
      this.nodes.set(d.id, g);
      svg.append(g);
    }
    this.fit();
    new ResizeObserver(() => this.fit()).observe(svg);
  }

  // 지도를 가로로 늘려 화면을 채운다
  private fit() {
    const { width, height } = this.svg.getBoundingClientRect();
    if (width && height) this.stretch = (MAP_H * width) / (height * MAP_W);
    const k = this.stretch;
    this.svg.setAttribute("viewBox", `0 0 ${MAP_W * k} ${MAP_H}`);
    this.ground.setAttribute("transform", `scale(${k} 1)`);
    this.legend.setAttribute("transform", `translate(${MAP_W * k - 118},${MAP_H - 96})`);
    for (const [e, [x, y]] of this.pins) e.setAttribute("transform", `translate(${Math.round(x * k)},${y})`);
    for (const [line, x1, x2] of this.lines) {
      line.setAttribute("x1", String(x1 * k));
      line.setAttribute("x2", String(x2 * k));
    }
  }

  // 지도 전체에서 클릭을 받아 가장 가까운 지역을 고른다. 휴대폰에서는 점이 작고 촘촘해 정확히 누르기 어렵다
  private tap(e: MouseEvent) {
    const m = this.svg.getScreenCTM();
    if (!m) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const pool = this.selectable?.length ? this.selectable : REGION_DEFS.map((d) => d.id);
    let best: number | null = null;
    let bestD = touchScreen() ? 60 : 18;
    for (const id of pool) {
      const d = REGION_DEFS[id - 1];
      const [x, y] = project(d.lon, d.lat);
      const dist = Math.hypot(x * this.stretch - p.x, y - p.y);
      if (dist <= bestD) {
        best = id;
        bestD = dist;
      }
    }
    if (best) this.onClick(best);
  }

  // 소유가 바뀔 때만 영역 그림을 다시 만든다
  private drawTerritory(s: GameState) {
    const key = s.regions.map((r) => r.owner ?? "-").join(",") + Object.values(s.factions).map((f) => f.name).join();
    if (key === this.territoryKey) return;
    this.territoryKey = key;
    const SC = 4; // 4 지도 단위 = 1 화소
    const cw = Math.ceil(MAP_W / SC);
    const ch = Math.ceil(MAP_H / SC);
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(cw, ch);
    const pts = REGION_DEFS.map((d) => {
      const [x, y] = project(d.lon, d.lat);
      const owner = s.regions[d.id - 1].owner;
      const hex = owner ? FACTION_INFO[owner].color : "#8d867a";
      return { x, y, rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)), owned: !!owner };
    });
    for (let py = 0; py < ch; py++) {
      for (let px = 0; px < cw; px++) {
        const x = px * SC + SC / 2;
        const y = py * SC + SC / 2;
        let best = 0;
        let bd = Infinity;
        let second = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const dd = (pts[i].x - x) ** 2 + (pts[i].y - y) ** 2;
          if (dd < bd) { second = bd; bd = dd; best = i; } else if (dd < second) second = dd;
        }
        const p = pts[best];
        const o = (py * cw + px) * 4;
        const far = Math.sqrt(bd);
        // 지역에서 멀수록 옅게, 다른 세력과의 경계는 진하게
        const edge = Math.sqrt(second) - far < 3 ? 0.25 : 0;
        const a = far > 90 ? 0 : (p.owned ? 0.34 : 0.12) * (1 - far / 110) + edge;
        img.data[o] = p.rgb[0];
        img.data[o + 1] = p.rgb[1];
        img.data[o + 2] = p.rgb[2];
        img.data[o + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    this.territory.setAttribute("href", canvas.toDataURL());

    // 나라 이름: 소유 지역들의 중심에 크게 쓴다
    for (const g of this.labels.children) this.pins.delete(g as SVGElement);
    this.labels.replaceChildren();
    this.legend.replaceChildren();
    const alive = Object.values(s.factions).filter((f) => f.alive);
    alive.forEach((f, i) => {
      const own = REGION_DEFS.filter((d) => s.regions[d.id - 1].owner === f.id).map((d) => project(d.lon, d.lat));
      if (own.length) {
        // 지역이 빽빽한 반도 남부에서는 이름이 지역 표시를 가리지 않도록 백제는 서해, 신라는 동해 쪽으로 비켜 쓴다
        const shift: Record<string, number> = { baekje: -62, silla: 64 };
        const cx = own.reduce((a, p) => a + p[0], 0) / own.length + (shift[f.id] ?? 0);
        const cy = own.reduce((a, p) => a + p[1], 0) / own.length;
        const g = el("g", { class: "realm" });
        this.pins.set(g, [cx, Math.round(cy)]);
        g.setAttribute("transform", `translate(${Math.round(cx * this.stretch)},${Math.round(cy)})`);
        const h = el("text", { y: -4, class: "realm-hanja", fill: FACTION_INFO[f.id].color });
        h.textContent = HANJA[f.id] ?? "";
        const k = el("text", { y: 12, class: "realm-name" });
        k.textContent = f.name;
        g.append(h, k);
        this.labels.append(g);
      }
      const row = el("g", { transform: `translate(8,${14 + i * 18})` });
      row.append(el("rect", { x: 0, y: -9, width: 14, height: 12, rx: 2, fill: FACTION_INFO[f.id].color, class: "legend-swatch" }));
      const t = el("text", { x: 20, y: 1, class: "legend-text" });
      t.textContent = `${f.name} ${s.regions.filter((r) => r.owner === f.id).length}지역`;
      row.append(t);
      this.legend.append(row);
    });
    this.legend.prepend(el("rect", { x: 0, y: 0, width: 112, height: 12 + alive.length * 18, rx: 4, class: "legend-bg" }));
  }

  render(s: GameState, focus?: number, selectable?: number[]) {
    this.selectable = selectable;
    this.drawTerritory(s);
    for (const [id, g] of this.nodes) {
      const r = s.regions[id - 1];
      const dot = g.querySelector<SVGCircleElement>(".dot")!;
      const num = g.querySelector<SVGTextElement>(".num")!;
      const info = r.owner ? FACTION_INFO[r.owner] : null;
      dot.style.fill = info ? info.color : "var(--empty)";
      num.style.fill = info ? info.ink : "var(--ink)";
      g.classList.toggle("focus", id === focus);
      g.classList.toggle("besieged", !!s.battles?.some((b) => b.target === id));
      g.classList.toggle("selectable", !!selectable?.includes(id));
      g.classList.toggle("dim", !!selectable && !selectable.includes(id));
    }
  }
}
