// 기록창 아래의 "해설 카드" (Vox 해설 영상 풍): 종이 질감, 찢은 종이 사진, 형광펜 제목, 붉은 주석, 실제 게임 수치.
// 장면은 고른 명령·계절·전투에 따라 바뀌고, 지금 보고 있는 지역의 그림·지도·장수·수치로 채운다.
// 움직임은 style.css의 .v-* (등장 한 번 + 느린 반복). prefers-reduced-motion이면 멈춘다.
import { regionDef, REGION_DEFS } from "../data/regions";
import { FACTION_INFO } from "../data/scenarios";
import type { BattleView, MissionView } from "../engine/io";
import { adjacent, connectedOwn, freeOfficersIn, governorOf, knowsRegion, menCap, menIn, officersIn, regionOf, relation, visibleMen } from "../engine/state";
import { FACTION_IDS, type FactionId, type GameState, type Officer } from "../engine/types";
import { battlefieldImg, officerImg, regionImg, strategicMapImg } from "./assets";
import { MAP_H, MAP_W, project } from "./map";

export interface SceneCtx {
  s: GameState | null;
  rid?: number; // 지금 보고 있는 지역
  battle?: BattleView | null;
  mission?: MissionView;
}

const NS = "http://www.w3.org/2000/svg";
type Kid = SVGElement | null | false | undefined;
type Attrs = Record<string, string | number | undefined>;

function s(tag: string, attrs: Attrs = {}, ...kids: Kid[]): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, String(v));
  for (const k of kids) if (k) e.append(k);
  return e;
}
const g = (attrs: Attrs, ...kids: Kid[]) => s("g", attrs, ...kids);
function t(x: number, y: number, str: string, cls: string, extra: Attrs = {}): SVGElement {
  const e = s("text", { x, y, class: cls, ...extra });
  e.textContent = str;
  return e;
}
// 등장 순서 지연 (초)
const delay = (d: number) => ({ style: `--d:${d}s` });

const W = 900;
const H = 300;
const PAPER = "#efe8da";
const CARD = "#fbf7ee";
const INK = "#1d1b18";
const RED = "#c8202e";
const YELLOW = "#f6d33c";
const HANJA: Record<FactionId, string> = { goguryeo: "高", baekje: "百", silla: "新", tang: "唐" };
const SEASON = [
  { ko: "봄", hanja: "春", note: "씨 뿌리는 철. 곡물값이 오르기 시작한다." },
  { ko: "여름", hanja: "夏", note: "장마철. 치수가 낮은 지역은 홍수를 조심해야 한다." },
  { ko: "가을", hanja: "秋", note: "9월에 거둔다. 곡물값이 가장 싼 때다." },
  { ko: "겨울", hanja: "冬", note: "군량을 아껴야 할 때. 봄까지 버텨야 한다." },
];
const seasonIdx = (m: number) => Math.min(3, Math.floor((m - 1) / 3));
const fmt = (n: number) => Math.round(n).toLocaleString("ko-KR");

let uid = 0;

// ── 바탕: 종이 질감·그림자·찢은 가장자리 ──
function jag(w: number, h: number, seed: number): string {
  const wob = (i: number) => ((Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1 * 5;
  const pts: string[] = [];
  const n = 28;
  for (let i = 0; i <= n; i++) pts.push(`${(w * i) / n},${wob(i)}`);
  for (let i = 0; i <= n / 2; i++) pts.push(`${w - wob(i + 40)},${(h * i) / (n / 2)}`);
  for (let i = n; i >= 0; i--) pts.push(`${(w * i) / n},${h - wob(i + 80)}`);
  for (let i = n / 2; i >= 0; i--) pts.push(`${wob(i + 120)},${(h * i) / (n / 2)}`);
  return pts.join(" ");
}

function defs(id: string): SVGElement {
  return s("defs", {},
    s("filter", { id: `${id}-grain`, x: 0, y: 0, width: "100%", height: "100%" },
      s("feTurbulence", { type: "fractalNoise", baseFrequency: 0.85, numOctaves: 2, stitchTiles: "stitch" }),
      s("feColorMatrix", { values: "0 0 0 0 0.25  0 0 0 0 0.2  0 0 0 0 0.12  0 0 0 0.55 0" })),
    s("filter", { id: `${id}-shadow`, x: "-10%", y: "-10%", width: "120%", height: "130%" },
      s("feDropShadow", { dx: 3, dy: 5, stdDeviation: 4, "flood-color": "#000", "flood-opacity": 0.28 })),
    s("clipPath", { id: `${id}-torn` }, s("polygon", { points: jag(340, 236, 1) })),
    s("clipPath", { id: `${id}-tornL` }, s("polygon", { points: jag(400, 252, 2) })),
    s("pattern", { id: `${id}-dots`, width: 7, height: 7, patternUnits: "userSpaceOnUse" }, s("circle", { cx: 2, cy: 2, r: 1.1, fill: INK, opacity: 0.18 })),
  );
}

// 사진 오려 붙이기: 흰 테두리 종이 + 찢은 가장자리 + 천천히 당겨 보기(Ken Burns)
function cutout(id: string, inner: SVGElement, x = 34, y = 30, rot = -2.2, wide = false): SVGElement {
  const w = wide ? 400 : 340;
  const h = wide ? 252 : 236;
  return g({ transform: `translate(${x} ${y}) rotate(${rot} ${w / 2} ${h / 2})` },
    g({ class: "v-in", ...delay(0) },
      g({ filter: `url(#${id}-shadow)` },
        g({ "clip-path": `url(#${id}-torn${wide ? "L" : ""})` },
          s("rect", { x: 0, y: 0, width: w, height: h, fill: CARD }),
          s("svg", { x: 9, y: 9, width: w - 18, height: h - 18, viewBox: `0 0 ${w - 18} ${h - 18}`, preserveAspectRatio: "xMidYMid slice" },
            g({ class: "v-kb" }, inner))))),
  );
}

// 사진 대신 쓰는 종이 판 (도표용)
const board = (id: string) => g({ class: "v-in" }, s("rect", { x: 26, y: 24, width: 380, height: 252, fill: CARD, filter: `url(#${id}-shadow)` }));

function photo(href: string, w = 322, h = 218): SVGElement {
  return s("image", { href, x: 0, y: 0, width: w, height: h, preserveAspectRatio: "xMidYMid slice" });
}

// 전략 지도 일부를 잘라 보여 주고 지도 좌표로 주석을 그린다
function mapCrop(center: [number, number], span: number, overlays: Kid[], w = 322, h = 218): SVGElement {
  const vh = (span * h) / w;
  return s("svg", { x: 0, y: 0, width: w, height: h, viewBox: `${center[0] - span / 2} ${center[1] - vh / 2} ${span} ${vh}`, preserveAspectRatio: "xMidYMid slice" },
    s("image", { href: strategicMapImg, x: 0, y: 0, width: MAP_W, height: MAP_H, preserveAspectRatio: "none" }),
    s("rect", { x: 0, y: 0, width: MAP_W, height: MAP_H, fill: PAPER, opacity: 0.2 }),
    ...overlays);
}
const pos = (rid: number) => project(regionDef(rid).lon, regionDef(rid).lat);

function dot(rid: number, color: string, label?: string, k = 1): SVGElement {
  const [x, y] = pos(rid);
  return g({},
    s("circle", { cx: x, cy: y, r: 5 * k, fill: color, stroke: "#fff", "stroke-width": 1.5 * k }),
    label ? t(x + 8 * k, y + 4 * k, label, "v-maplabel", { "font-size": 12 * k }) : null,
  );
}

// 손으로 그은 듯한 화살표 (그려지며 나타남)
function arrow(a: number, b: number, color: string, i: number, dashed = false): SVGElement {
  const [x1, y1] = pos(a);
  const [x2, y2] = pos(b);
  const mx = (x1 + x2) / 2 + (y2 - y1) * 0.18;
  const my = (y1 + y2) / 2 - (x2 - x1) * 0.18;
  const ang = Math.atan2(y2 - my, x2 - mx);
  const hx = x2 - Math.cos(ang) * 8;
  const hy = y2 - Math.sin(ang) * 8;
  const head = `M${hx - Math.cos(ang - 0.5) * 9} ${hy - Math.sin(ang - 0.5) * 9} L${hx} ${hy} L${hx - Math.cos(ang + 0.5) * 9} ${hy - Math.sin(ang + 0.5) * 9}`;
  // 점선은 대시 무늬를 지키려고 그리기 대신 나타나기로 보인다
  return g({ class: dashed ? "v-in" : "v-draw", ...delay(0.5 + i * 0.25) },
    s("path", { d: `M${x1} ${y1} Q${mx} ${my} ${hx} ${hy}`, fill: "none", stroke: color, "stroke-width": 3, "stroke-linecap": "round", pathLength: 100, "stroke-dasharray": dashed ? "5 4" : undefined }),
    s("path", { d: head, fill: "none", stroke: color, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round", pathLength: 100 }),
  );
}

// 붉은 펜으로 대충 두른 동그라미
function scribble(cx: number, cy: number, r: number, d = 0.6): SVGElement {
  const p = `M${cx - r} ${cy} C${cx - r} ${cy - r * 0.9} ${cx + r * 1.05} ${cy - r * 1.05} ${cx + r} ${cy} S${cx - r * 0.7} ${cy + r * 1.1} ${cx - r * 1.08} ${cy - r * 0.15}`;
  return s("path", { d: p, fill: "none", stroke: RED, "stroke-width": 3, "stroke-linecap": "round", pathLength: 100, class: "v-draw", ...delay(d) });
}

function portraits(id: string, list: Officer[], strike = false): SVGElement {
  const pick = list.slice(0, 3);
  if (!pick.length) return board(id);
  return g({}, ...pick.map((o, i) =>
    g({ transform: `translate(${26 + i * 120} ${40 + (i % 2) * 16}) rotate(${[-4, 2.5, -1.5][i]} 64 84)` },
      g({ class: "v-in", ...delay(0.1 + i * 0.15) },
        g({ filter: `url(#${id}-shadow)` },
          s("rect", { x: 0, y: 0, width: 128, height: 168, fill: CARD }),
          s("image", { href: officerImg(o.id), x: 8, y: 8, width: 112, height: 128, preserveAspectRatio: "xMidYMid slice" }),
          t(64, 157, o.name, "v-polaroid", { "text-anchor": "middle" })),
        strike && s("path", { d: "M14 20 L114 130 M114 20 L14 130", stroke: RED, "stroke-width": 5, "stroke-linecap": "round", pathLength: 100, class: "v-draw", ...delay(0.7 + i * 0.2) })))));
}

// ── 오른쪽: 머리글·제목·본문·수치 ──
function headline(kicker: string, title: string, hanja: string, body: string): SVGElement[] {
  const x = 430;
  const tw = Math.min(400, [...title].length * 46 + 8);
  return [
    t(x, 60, kicker, "v-kicker v-in", delay(0.15)),
    s("rect", { x: x - 6, y: 84, width: tw + 12, height: 38, fill: YELLOW, class: "v-hl", ...delay(0.35) }),
    t(x, 116, title, "v-title v-in", delay(0.2)),
    t(x + tw + 16, 114, hanja, "v-hanja v-in", delay(0.45)),
    ...wrap(body, 31).map((line, i) => t(x, 154 + i * 21, line, "v-body v-in", delay(0.5 + i * 0.08))),
  ];
}

function wrap(str: string, n: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of str.split(" ")) {
    if ((cur + " " + word).trim().length > n && cur) {
      out.push(cur);
      cur = word;
    } else cur = (cur + " " + word).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, 2);
}

// 큰 숫자 + 작은 이름표 (Vox 수치 강조)
function stats(items: [string, string][], y = 232): SVGElement {
  return g({}, ...items.slice(0, 4).map(([k, v], i) => g({ class: "v-in", ...delay(0.7 + i * 0.12) },
    t(430 + i * 112, y, v, "v-num"),
    s("line", { x1: 430 + i * 112, y1: y + 9, x2: 430 + i * 112 + 96, y2: y + 9, stroke: INK, "stroke-width": 1 }),
    t(430 + i * 112, y + 27, k, "v-label"))));
}

// 가로 막대 (값/최대)
function bars(items: { label: string; v: number; max: number; color?: string; note?: string }[], y = 210, w = 260): SVGElement {
  return g({}, ...items.slice(0, 3).map((b, i) => {
    const yy = y + i * 28;
    const frac = Math.max(0.02, Math.min(1, b.v / (b.max || 1)));
    return g({ class: "v-in", ...delay(0.7 + i * 0.12) },
      t(430, yy + 13, b.label, "v-label"),
      s("rect", { x: 510, y: yy, width: w, height: 16, fill: INK, opacity: 0.08 }),
      s("rect", { x: 510, y: yy, width: w * frac, height: 16, fill: b.color ?? INK, class: "v-bar", ...delay(0.85 + i * 0.12) }),
      t(510 + w + 8, yy + 13, b.note ?? fmt(b.v), "v-label"));
  }));
}

// ── 장면 정의 ──
type Ctx = SceneCtx & { s: GameState };
type Builder = (id: string, c: Ctx) => Kid[];

const CMD: Record<number, { name: string; hanja: string; body: string }> = {
  0: { name: "휴식", hanja: "休息", body: "이번 달 이 지역은 명령 없이 지나간다." },
  1: { name: "이동", hanja: "移動", body: "장수와 금·군량을 맞닿은 아군 지역으로 옮긴다." },
  2: { name: "수송", hanja: "輸送", body: "아군 땅으로 이어진 지역에 금과 군량을 보낸다." },
  3: { name: "전쟁", hanja: "戰爭", body: "맞닿은 적 지역으로 출병한다. 본성을 빼앗거나 적을 모두 물리치면 이긴다. 총대장을 잃으면 병사 일부가 달아난다." },
  4: { name: "군사", hanja: "軍事", body: "징병·훈련·무장으로 군을 키운다. 훈련이 높을수록 전장에서 멀리 움직인다." },
  5: { name: "인재", hanja: "人才", body: "숨은 인재를 찾아 등용하거나 적 장수를 빼내 온다." },
  6: { name: "외교", hanja: "外交", body: "예물과 동맹으로 다른 나라와의 관계를 바꾼다." },
  7: { name: "첩보", hanja: "諜報", body: "적 지역의 사정을 캐내거나 유언비어로 흔든다." },
  8: { name: "정보", hanja: "情報", body: "나라·장수·다른 나라의 형편을 살핀다." },
  9: { name: "개간", hanja: "開墾", body: "금을 들여 땅을 일군다. 개발이 높을수록 가을 수확이 는다." },
  10: { name: "치수", hanja: "治水", body: "둑을 쌓아 여름 홍수에 대비한다. 수확도 안정된다." },
  11: { name: "포상", hanja: "褒賞", body: "금을 내려 장수의 충성을 높인다. 충성이 낮으면 떠나거나 넘어간다." },
  12: { name: "시혜", hanja: "施惠", body: "군량을 풀어 민심을 얻는다. 민심이 20 아래면 민란이 인다." },
  13: { name: "상인", hanja: "商人", body: "군량·군마·무기를 사고판다. 수확 직후 곡물값이 가장 싸다." },
  14: { name: "세율", hanja: "稅率", body: "세율을 올리면 수입이 늘지만 민심이 떨어진다." },
  15: { name: "세력", hanja: "勢力", body: "네 나라의 영토·장수·병력을 견주어 본다." },
  16: { name: "위임", hanja: "委任", body: "이 지역을 관리에게 맡겨 스스로 다스리게 한다." },
  17: { name: "추방", hanja: "追放", body: "장수를 내보낸다. 쫓겨난 장수는 재야로 돌아간다." },
  18: { name: "조언", hanja: "助言", body: "책사에게 지금 무엇을 해야 할지 묻는다." },
  19: { name: "기타", hanja: "其他", body: "저장·불러오기와 다른 세력 전투 보기 설정." },
};

function regionCtx(c: Ctx) {
  const rid = c.rid ?? REGION_DEFS[0].id;
  const r = regionOf(c.s, rid);
  const f = r.owner;
  return { rid, r, f, offs: officersIn(c.s, rid), color: f ? FACTION_INFO[f].color : "#8a8478" };
}

function cmdScene(no: number): Builder {
  const info = CMD[no];
  return (id, c) => {
    const { rid, r, f, offs, color } = regionCtx(c);
    const head = headline(`명령 ${String(no).padStart(2, "0")} · ${r.name}`, info.name, info.hanja, info.body);
    const center = pos(rid);
    const enemies = adjacent(rid).filter((n) => regionOf(c.s, n).owner !== f);
    const friends = adjacent(rid).filter((n) => regionOf(c.s, n).owner === f);
    const ownColor = (n: number) => {
      const o = regionOf(c.s, n).owner;
      return o ? FACTION_INFO[o].color : "#8a8478";
    };
    const name = (n: number) => regionOf(c.s, n).name;

    if (no === 1 || no === 2) {
      const dests = (no === 1 ? friends : connectedOwn(c.s, rid)).slice(0, 6);
      const far = Math.max(0, ...dests.map((d) => Math.hypot(pos(d)[0] - center[0], pos(d)[1] - center[1])));
      return [cutout(id, mapCrop(center, Math.min(420, 150 + far * 1.8), [
        ...dests.map((d, i) => arrow(rid, d, INK, i, true)), dot(rid, color, r.name, 1.2), ...dests.map((d) => dot(d, ownColor(d), name(d)))])),
        ...head, stats([["보낼 수 있는 곳", `${dests.length}곳`], ["금", fmt(r.gold)], ["군량", fmt(r.food)], ["병사", fmt(menIn(c.s, rid))]])];
    }
    if (no === 3) {
      const tg = enemies.slice(0, 4);
      const foe = (d: number) => visibleMen(c.s, d, f);
      const max = Math.max(menIn(c.s, rid), ...tg.map(foe), 1);
      return [cutout(id, mapCrop(center, 210, [...tg.map((d, i) => arrow(rid, d, RED, i)), dot(rid, color, r.name, 1.2), ...tg.map((d) => dot(d, ownColor(d), name(d)))])),
        ...head, bars([{ label: "아군", v: menIn(c.s, rid), max, color: RED }, ...tg.slice(0, 2).map((d) => ({ label: name(d), v: foe(d), max, color: ownColor(d), note: `${knowsRegion(c.s, d, f) ? "" : "약 "}${fmt(foe(d))}` }))], 210)];
    }
    if (no === 4 || no === 11 || no === 17) {
      const list = [...offs].sort((a, b) => (no === 11 ? a.loy - b.loy : b.war - a.war));
      const viz = no === 4
        ? bars(list.slice(0, 3).map((o) => ({ label: o.name, v: o.men, max: menCap(o), note: `${fmt(o.men)} · 훈련 ${o.trn}` })), 210, 220)
        : no === 11
          ? bars(list.slice(0, 3).map((o) => ({ label: o.name, v: o.loy, max: 100, color: o.loy < 60 ? RED : INK })), 210)
          : stats([["장수", `${offs.length}명`], ["가장 낮은 충성", String(Math.min(100, ...offs.map((o) => o.loy)))]]);
      return [portraits(id, list, no === 17), ...head, viz];
    }
    if (no === 5) {
      const free = freeOfficersIn(c.s, rid);
      const known = free.filter((o) => !o.hidden);
      return [portraits(id, known.length ? known : offs), ...head,
        stats([["알려진 재야", `${known.length}명`], ["소문만 있는 인재", `${free.length - known.length}명`], ["우리 장수", `${offs.length}명`]])];
    }
    if (no === 6) {
      // 우리 나라 도장을 가운데 두고 다른 나라와의 우호도를 선으로
      const others = FACTION_IDS.filter((x) => c.s.factions[x].alive && x !== f);
      const cx = 216;
      const cy = 112;
      const pts = others.map((_, i) => {
        const a = Math.PI / 2 + (i - (others.length - 1) / 2) * 1.05;
        return [cx + Math.cos(a) * 140, cy + Math.sin(a) * 110] as const;
      });
      const seal = (x: number, y: number, fid: FactionId, d: number, big = false) => g({ class: "v-in", ...delay(d) },
        s("rect", { x: x - (big ? 34 : 26), y: y - (big ? 34 : 26), width: big ? 68 : 52, height: big ? 68 : 52, fill: FACTION_INFO[fid].color, rx: 4, filter: `url(#${id}-shadow)` }),
        t(x, y + (big ? 13 : 10), HANJA[fid], "v-seal", { "text-anchor": "middle", "font-size": big ? 38 : 28 }));
      return [board(id), s("rect", { x: 26, y: 24, width: 380, height: 252, fill: `url(#${id}-dots)` }),
        ...others.map((x, i) => {
          const rel = f ? relation(c.s, f, x) : 30;
          return g({},
            s("line", { x1: cx, y1: cy, x2: pts[i][0], y2: pts[i][1], stroke: rel >= 60 ? INK : RED, "stroke-width": 1 + rel / 25, pathLength: 100, class: "v-draw", ...delay(0.4 + i * 0.15) }),
            t((cx + pts[i][0]) / 2 + 8, (cy + pts[i][1]) / 2, String(rel), "v-num-s v-in", delay(0.8 + i * 0.15)));
        }),
        f && seal(cx, cy, f, 0.2, true), ...others.map((x, i) => seal(pts[i][0], pts[i][1], x, 0.3 + i * 0.12)),
        ...head, t(430, 230, "선 위의 숫자 = 우호도", "v-label v-in", delay(1)), t(430, 252, "60 이상이면 동맹을 맺기 쉽다", "v-label v-in", delay(1.1))];
    }
    if (no === 7) {
      const tg = enemies.slice(0, 4);
      const [x0, y0] = center;
      return [cutout(id, mapCrop(center, 220, [
        g({ class: "v-sweep", style: `transform-origin:${x0}px ${y0}px` },
          s("path", { d: `M${x0} ${y0} L${x0 + 70} ${y0} A70 70 0 0 0 ${x0 + 49.5} ${y0 - 49.5} Z`, fill: RED, opacity: 0.25 })),
        s("circle", { cx: x0, cy: y0, r: 70, fill: "none", stroke: RED, "stroke-width": 1, opacity: 0.6 }),
        dot(rid, color, r.name, 1.2),
        ...tg.map((d, i) => g({}, dot(d, ownColor(d), `${name(d)} ?`), scribble(pos(d)[0], pos(d)[1], 13, 0.8 + i * 0.2)))])),
        ...head, stats([["맞닿은 적 지역", `${tg.length}곳`], ["병사", fmt(menIn(c.s, rid))]])];
    }
    if (no === 13) {
      // 곡물값: 수확 직후(9~11월) 싸고 봄(3~6월)에 비싸다 (economy.ts)
      const base = (m: number) => (m >= 9 && m <= 11 ? 7 : m >= 3 && m <= 6 ? 13 : 10);
      const px = (m: number) => 60 + (m - 1) * 29;
      const py = (v: number) => 236 - (v - 5) * 15;
      const line = Array.from({ length: 12 }, (_, i) => `${i ? "L" : "M"}${px(i + 1)} ${py(base(i + 1))}`).join(" ");
      return [board(id), t(46, 58, "곡물값 (100석당 금)", "v-label v-in", delay(0.1)),
        ...Array.from({ length: 12 }, (_, i) => t(px(i + 1), 262, String(i + 1), "v-tick", { "text-anchor": "middle" })),
        s("path", { d: line, fill: "none", stroke: INK, "stroke-width": 3, pathLength: 100, class: "v-draw", ...delay(0.3) }),
        g({ class: "v-in", ...delay(1.1) }, s("circle", { cx: px(c.s.month), cy: py(c.s.foodPrice), r: 7, fill: RED }),
          t(px(c.s.month) + 10, py(c.s.foodPrice) - 10, `지금 ${c.s.foodPrice}`, "v-num-s")),
        scribble(px(10), py(7), 24, 1.3),
        ...head, stats([["군량 100석", `금 ${c.s.foodPrice}`], ["금", fmt(r.gold)], ["군량", fmt(r.food)]])];
    }
    if (no === 14) {
      return [board(id),
        s("path", { d: "M80 226 A136 136 0 0 1 352 226", fill: "none", stroke: INK, "stroke-width": 18, opacity: 0.1 }),
        s("path", { d: "M80 226 A136 136 0 0 1 352 226", fill: "none", stroke: RED, "stroke-width": 18, pathLength: 100, "stroke-dasharray": `${r.rate} 100`, class: "v-in", ...delay(0.3) }),
        g({ transform: "translate(216 226)" },
          g({ class: "v-needle", style: `--a:${-90 + (r.rate / 100) * 180}deg` },
            s("line", { x1: 0, y1: 0, x2: 0, y2: -118, stroke: INK, "stroke-width": 4, "stroke-linecap": "round" }), s("circle", { cx: 0, cy: 0, r: 9, fill: INK }))),
        t(216, 262, `세율 ${r.rate}%`, "v-num-s", { "text-anchor": "middle" }),
        t(62, 248, "0", "v-tick"), t(344, 248, "100", "v-tick"),
        ...head, bars([{ label: "민심", v: r.loyalty, max: 100, color: r.loyalty < 35 ? RED : INK }], 204),
        stats([["반년 세금(어림)", `금 ${fmt(r.pop * (r.rate / 100) * 0.025 * (0.5 + r.loyalty / 200))}`]], 254)];
    }
    if (no === 15) {
      const alive = FACTION_IDS.filter((x) => c.s.factions[x].alive);
      const regs = alive.map((x) => c.s.regions.filter((rr) => rr.owner === x).length);
      const max = Math.max(...regs, 1);
      const lead = alive[regs.indexOf(Math.max(...regs))];
      return [board(id), t(46, 58, "영토 (지역 수)", "v-label v-in", delay(0.1)),
        ...alive.map((x, i) => {
          const y = 76 + i * 46;
          const bw = 220 * (regs[i] / max);
          return g({ class: "v-in", ...delay(0.2 + i * 0.1) },
            t(46, y + 22, c.s.factions[x].name, "v-chartlabel"),
            s("rect", { x: 120, y: y + 4, width: bw, height: 26, fill: FACTION_INFO[x].color, class: "v-bar", ...delay(0.4 + i * 0.1) }),
            t(128 + bw, y + 24, String(regs[i]), "v-num-s"));
        }),
        ...head, stats([["가장 넓은 나라", lead ? c.s.factions[lead].name : "-"], ["살아 있는 나라", `${alive.length}`]])];
    }
    if (no === 18) {
      const sage = [...offs].sort((a, b) => b.int - a.int)[0];
      return [sage ? portraits(id, [sage]) : cutout(id, photo(regionImg(rid))),
        t(172, 96, "“", "v-quote v-in", delay(0.5)),
        ...head, stats([["책사", sage?.name ?? "-"], ["지력", String(sage?.int ?? "-")]])];
    }
    if (no === 19) {
      return [...[0, 1, 2].map((i) => g({ transform: `translate(${44 + i * 116} ${52 + i * 10}) rotate(${[-3, 1.5, 4][i]} 60 80)` },
        g({ class: "v-in", ...delay(0.1 + i * 0.12) },
          g({ filter: `url(#${id}-shadow)` }, s("rect", { x: 0, y: 0, width: 120, height: 160, fill: CARD }),
            t(60, 78, String(i + 1), "v-num", { "text-anchor": "middle" }), t(60, 108, "저장 칸", "v-label", { "text-anchor": "middle" }))))),
        ...head];
    }
    // 지역 그림 + 지역 수치 (0 휴식, 8 정보, 9 개간, 10 치수, 12 시혜, 16 위임)
    const viz =
      no === 9 ? bars([{ label: "개발", v: r.land, max: 100, color: "#5f7d3a" }, { label: "인구", v: r.pop, max: 300000 }], 210)
      : no === 10 ? bars([{ label: "치수", v: r.flood, max: 100, color: "#3f6f97" }, { label: "개발", v: r.land, max: 100 }], 210)
      : no === 12 ? bars([{ label: "민심", v: r.loyalty, max: 100, color: r.loyalty < 35 ? RED : INK }, { label: "군량", v: r.food, max: Math.max(r.food, r.pop) }], 210)
      : no === 0 ? stats([["지금", `${c.s.month}월`], ["다음 달", `${(c.s.month % 12) + 1}월`]])
      : stats([["인구", fmt(r.pop)], ["성곽", String(r.forts)], ["개발", String(r.land)], ["치수", String(r.flood)]]);
    const extra = no === 16
      ? g({ transform: "translate(300 200) rotate(-10)" }, g({ class: "v-stamp" },
        s("rect", { x: -46, y: -46, width: 92, height: 92, fill: "none", stroke: RED, "stroke-width": 6, rx: 6 }),
        t(0, 13, "委任", "v-seal", { "text-anchor": "middle", fill: RED, "font-size": 32 })))
      : no === 9 || no === 10 || no === 12 ? scribble(206, 150, 74, 0.9) : null;
    return [cutout(id, photo(regionImg(rid))), extra, ...head, viz];
  };
}

const SCENES: Record<string, Builder> = {
  title: (id, c) => {
    const alive = FACTION_IDS.filter((x) => c.s.factions[x].alive);
    const tags = alive.map((x, i) => {
      const own = c.s.regions.filter((r) => r.owner === x).map((r) => pos(r.id));
      const cx = own.reduce((a, p) => a + p[0], 0) / own.length;
      const cy = own.reduce((a, p) => a + p[1], 0) / own.length;
      return g({ class: "v-in", ...delay(0.6 + i * 0.2) },
        s("rect", { x: cx - 34, y: cy - 18, width: 68, height: 32, fill: FACTION_INFO[x].color }),
        t(cx, cy + 6, c.s.factions[x].name, "v-tag", { "text-anchor": "middle" }));
    });
    // 모든 지역의 가운데를 잡아 네 나라가 다 들어오게 자른다
    const all = REGION_DEFS.map((d) => pos(d.id));
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const mid: [number, number] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const span = Math.max(Math.max(...xs) - Math.min(...xs), ((Math.max(...ys) - Math.min(...ys)) * 382) / 234) + 60;
    return [cutout(id, mapCrop(mid, span, tags, 382, 234), 20, 24, -1.5, true),
      ...headline(`${c.s.year}년 · 7세기 한반도`, "삼한지", "三韓志", "고구려·백제·신라, 그리고 당. 한반도의 패권을 두고 네 나라가 맞선다."),
      g({}, ...alive.map((x, i) => g({ class: "v-in", ...delay(0.8 + i * 0.1) },
        s("rect", { x: 430 + i * 104, y: 222, width: 14, height: 14, fill: FACTION_INFO[x].color }),
        t(450 + i * 104, 234, c.s.factions[x].name, "v-label"))))];
  },
  menu: (id, c) => {
    const { rid, r, f, offs } = regionCtx(c);
    const ruler = f ? c.s.factions[f].ruler : null;
    const gov = governorOf(c.s, rid);
    const direct = !!gov && gov.id === ruler;
    // 태수 초상을 지역 그림 위에 핀으로 꽂는다
    const pin = gov && g({ transform: "translate(282 150) rotate(5 46 60)" },
      g({ class: "v-in", ...delay(0.5) },
        g({ filter: `url(#${id}-shadow)` },
          s("rect", { x: 0, y: 0, width: 92, height: 120, fill: CARD }),
          s("image", { href: officerImg(gov.id), x: 6, y: 6, width: 80, height: 88, preserveAspectRatio: "xMidYMid slice" }),
          t(46, 110, `${direct ? "직할" : "태수"} ${gov.name}`, "v-polaroid", { "text-anchor": "middle", "font-size": 11 })),
        s("circle", { cx: 46, cy: 4, r: 5, fill: RED })));
    return [cutout(id, photo(regionImg(rid))), pin,
      ...headline(`${c.s.year}년 ${c.s.month}월 · ${SEASON[seasonIdx(c.s.month)].ko}`, r.name, regionDef(rid).hanja,
        `${gov ? `${direct ? "군주 직할" : "태수"} ${gov.name}` : "태수 없음"}${ruler && !direct ? ` · 군주 ${c.s.officers[ruler].name}` : ""} · 장수 ${offs.length}명`),
      stats([["병사", fmt(menIn(c.s, rid))], ["금", fmt(r.gold)], ["군량", fmt(r.food)], ["민심", String(r.loyalty)]])];
  },
  season: (id, c) => {
    const { rid } = regionCtx(c);
    const se = SEASON[seasonIdx(c.s.month)];
    return [cutout(id, photo(regionImg(rid))), ...headline(`${c.s.year}년 · 새 달`, `${c.s.month}월`, se.hanja, `${se.ko} — ${se.note}`),
      ...Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const cur = m === c.s.month;
        return g({ class: "v-in", ...delay(0.6 + i * 0.04) },
          s("rect", { x: 430 + i * 36, y: 210, width: 30, height: 30, fill: cur ? RED : m === 9 ? YELLOW : INK, opacity: cur || m === 9 ? 1 : 0.1 }),
          t(445 + i * 36, 230, String(m), cur ? "v-tick v-tick-on" : "v-tick", { "text-anchor": "middle" }));
      }),
      t(430, 266, "노란 칸 = 9월 수확", "v-label v-in", delay(1))];
  },
  battle: (id, c) => {
    const v = c.battle;
    if (!v) return SCENES.menu(id, c);
    const max = Math.max(v.atk.men, v.def.men, 1);
    return [cutout(id, photo(battlefieldImg(v.regionId))),
      ...headline(`전투 · ${regionOf(c.s, v.regionId).name}`, "출진", "出陣", "본성을 빼앗거나 적을 모두 물리치면 끝난다. 총대장을 잃으면 병사가 달아난다. 못 끝내면 다음 달로 이어진다."),
      bars([{ label: v.atk.label, v: v.atk.men, max, color: RED, note: `${fmt(v.atk.men)} · 장수 ${v.atk.generals}` },
        { label: v.def.label, v: v.def.men, max, color: INK, note: `${fmt(v.def.men)} · 장수 ${v.def.generals + v.def.reserve}` }], 210, 220)];
  },
};
for (let i = 0; i <= 19; i++) SCENES[`cmd${i}`] = cmdScene(i);
for (const k of ["spring", "summer", "autumn", "winter"]) SCENES[k] = SCENES.season;

// 역사 임무: 안시성 그림과 지금 수치
SCENES.mission = (id, c) => {
  const m = c.mission;
  if (!m) return [];
  return [cutout(id, photo(regionImg(4))), ...headline(m.date, m.title, "安市城", m.body),
    stats(m.stats.map((x) => [x.label, String(x.v)]))];
};

export const SCENE_KINDS = Object.keys(SCENES);

export function buildScene(kind: string, ctx: SceneCtx): SVGSVGElement {
  const id = `v${++uid}`;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true", class: "vox" }) as SVGSVGElement;
  svg.append(defs(id), s("rect", { x: 0, y: 0, width: W, height: H, fill: PAPER }));
  if (ctx.s) for (const k of (SCENES[kind] ?? SCENES.menu)(id, { ...ctx, s: ctx.s })) if (k) svg.append(k);
  svg.append(s("rect", { x: 0, y: 0, width: W, height: H, filter: `url(#${id}-grain)`, opacity: 0.3, style: "mix-blend-mode:multiply", "pointer-events": "none" }));
  return svg;
}
