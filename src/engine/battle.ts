// 전술 전투: 『삼국지 2』의 야전을 본뜬 육각 전장 전투.
// 원작 관찰 사항(docs/01-rtk2-eng-analysis.md §8): 출발 지역 쪽 가장자리 진입, 총대장, 성 여러 개,
// 날씨·바람, 군량(병사 1명당 한 달 1석), 30일 제한, 부대 명령 1이동 2공격 3대기 4정보 5계략 6퇴각, 일기토 이벤트.
import { regionDef } from "../data/regions";
import { isSea } from "../data/regions";
import { FACTION_INFO } from "../data/scenarios";
import {
  COLS, DIR_ARROW, DIR_NAME, FIRE_BASE, MOVE_COST, ROWS, SORTIE_DIV, TERRAIN_DIV, TERRAIN_NAME, colOf, dist, entryHexes,
  makeField, neighbors, reachable, rowOf, step, type Edge, type Field,
} from "./hex";
import type { BattleFx, BattleView, IO, Option, SideView } from "./io";
import { MAX_FOOD, MAX_GOLD } from "./economy";
import { checkFactions, killOfficer, succeed } from "./politics";
import {
  adjacent, battleAt, breakAlliance, capitalOf, chance, changeRelation, clamp, isAllied, officersIn, rand, regionOf,
} from "./state";
import type { Arrival, FactionId, GameState, OngoingBattle, Officer, Region, SavedSide } from "./types";

export const MAX_DAYS = 30;
export const MAX_UNITS = 10;
const DESERT_RATE = 0.2; // 총대장을 잃었을 때 남은 부대에서 달아나는 병사 비율 [설계]

type SideKey = "atk" | "def";
type Weather = "맑음" | "흐림" | "비" | "눈";

interface Unit {
  o: Officer;
  side: SideKey;
  faction: FactionId | null; // 원군이면 동맹국
  hex: number;
  done: boolean;
  moved: boolean;
  gone: boolean; // 전장을 떠남(퇴각)
  home: number; // 퇴각·귀환할 지역
}

interface Side {
  key: SideKey;
  faction: FactionId | null;
  label: string;
  player: boolean;
  units: Unit[];
  reserve: Officer[]; // 출전하지 않고 성에 남은 장수
  commander: Unit | null;
  food: number;
  gold: number;
  captives: Officer[]; // 이 편이 사로잡은 적 장수
}

export interface WarOrder {
  officers: Officer[]; // 첫 장수가 총대장
  food: number;
  gold: number;
}

function makeMilitia(r: Region): Officer {
  return {
    id: "__militia", name: "수비군", born: 0, died: 9999,
    int: 30, war: 35, chr: 0, loy: 100,
    men: Math.floor(r.pop * (r.owner ? 0.02 : 0.01)),
    trn: 30, arm: 30, faction: r.owner, region: r.id, hidden: false, alive: true,
  };
}

const isUp = (u: Unit) => !u.gone && u.o.alive && u.o.men > 0;

// 출발 지역이 목표 지역의 어느 쪽에 있는가
function edgeFrom(fromId: number, targetId: number): Edge {
  const a = regionDef(fromId);
  const b = regionDef(targetId);
  const dx = a.lon - b.lon;
  const dy = a.lat - b.lat;
  if (Math.abs(dx) * 1.2 >= Math.abs(dy)) return dx > 0 ? "east" : "west";
  return dy > 0 ? "north" : "south";
}

function pickCommander(list: Officer[], s: GameState, f: FactionId | null): Officer | undefined {
  const ruler = f ? s.factions[f].ruler : null;
  return list.find((o) => o.id === ruler) ?? [...list].sort((a, b) => b.war + b.int + b.chr - (a.war + a.int + a.chr))[0];
}

export class Battle {
  field: Field;
  atk: Side;
  def: Side;
  day = 1;
  private paths = new Map<string, Map<number, number>>();
  result: SideKey | null = null;
  reason = "";
  watch: boolean;
  interactive: boolean;
  sea: boolean;
  edge: Edge;
  entries: number[];
  weather: Weather = "맑음";
  wind: number | null = null;
  fires = new Map<number, number>(); // 칸 → 남은 일수

  constructor(public s: GameState, public io: IO, public from: Region, public target: Region, attacker: FactionId, defF: FactionId | null = target.owner) {
    this.field = makeField(target.id * 977 + 31, target.forts);
    this.sea = isSea(from.id, target.id);
    this.edge = edgeFrom(from.id, target.id);
    this.entries = entryHexes(this.field, this.edge);
    this.atk = {
      key: "atk", faction: attacker, label: s.factions[attacker].name,
      player: s.factions[attacker].player && !from.delegated, units: [], reserve: [], commander: null,
      food: 0, gold: 0, captives: [],
    };
    this.def = {
      key: "def", faction: defF, label: defF ? s.factions[defF].name : "토착 세력",
      player: !!defF && s.factions[defF].player, units: [], reserve: [], commander: null,
      food: target.food, gold: target.gold, captives: [],
    };
    this.interactive = this.atk.player || this.def.player;
    this.watch = this.interactive || s.showOtherBattles;
  }

  // ── 편성·배치 ──
  async setup() {
    const s = this.s;
    const defenders = officersIn(s, this.target.id).filter((o) => o.men > 0);
    let deployed: Officer[];
    if (!defenders.length) deployed = [makeMilitia(this.target)];
    else if (this.def.player && defenders.length > 1) deployed = await this.chooseDefenders(defenders);
    else deployed = [...defenders].sort((a, b) => b.men - a.men).slice(0, MAX_UNITS);
    const cmd = this.def.player && defenders.length > 1 ? deployed[0] : pickCommander(deployed, s, this.def.faction) ?? deployed[0];
    deployed = [cmd, ...deployed.filter((o) => o !== cmd)];
    this.def.reserve = officersIn(s, this.target.id).filter((o) => !deployed.includes(o));
    for (const o of deployed) {
      this.def.units.push({ o, side: "def", faction: this.def.faction, hex: 0, done: false, moved: false, gone: false, home: this.target.id });
    }
    this.def.commander = this.def.units[0];

    // 동맹국 원군 (각 편 1부대)
    for (const side of [this.atk, this.def]) {
      const foeF = this.other(side).faction;
      const ally = Object.values(s.factions).find((f) => f.alive && side.faction && isAllied(s, side.faction, f.id) && f.id !== foeF);
      if (!ally) continue;
      const near = adjacent(this.target.id).filter((n) => regionOf(s, n).owner === ally.id);
      const helper = near.flatMap((n) => officersIn(s, n)).filter((o) => o.men >= 500 && ally.ruler !== o.id).sort((a, b) => b.war - a.war)[0];
      if (!helper || side.units.length >= MAX_UNITS + 1) continue;
      side.units.push({ o: helper, side: side.key, faction: ally.id, hex: 0, done: false, moved: false, gone: false, home: helper.region });
      this.log(`${ally.name}의 ${helper.name}이(가) 원군으로 달려왔다!`);
    }

    // 수비측 배치: 총대장은 본성, 나머지는 다른 성과 본성 주변
    const f = this.field;
    const ring = [...f.castles, ...neighbors(f.hq), ...f.castles.slice(1).flatMap(neighbors), ...neighbors(f.hq).flatMap(neighbors)];
    const slots = [...new Set(ring)].filter((h) => f.terrain[h - 1] !== "river");
    const taken = new Set<number>();
    for (const u of this.def.units) {
      const h = slots.find((x) => !taken.has(x)) ?? this.nearestFree(f.hq, taken);
      u.hex = h;
      taken.add(h);
    }

    // 공격측 배치: 진입 칸에 한 부대씩 (원작 "Position where?")
    const order = [...this.entries].sort((a, b) => Math.abs(this.mid(a)) - Math.abs(this.mid(b)));
    for (const u of this.atk.units) {
      const free = order.filter((h) => !taken.has(h));
      let h = free[0];
      if (this.atk.player && free.length > 1 && u.faction === this.atk.faction) {
        this.render(u, free);
        h = (await this.io.pickHex(`${u.o.name}${u === this.atk.commander ? "(총대장)" : ""} — 배치할 진입 칸`, free, undefined, "자동 배치")) ?? free[0];
      }
      if (!h) h = this.nearestFree(order[0], taken);
      u.hex = h;
      taken.add(h);
    }
  }

  mid(h: number) {
    return this.edge === "west" || this.edge === "east" ? rowOf(h) - ROWS / 2 : colOf(h) - COLS / 2;
  }

  nearestFree(from: number, taken: Set<number>): number {
    const all = Array.from({ length: COLS * ROWS }, (_, i) => i + 1).filter((h) => !taken.has(h) && this.field.terrain[h - 1] !== "castle");
    return all.sort((a, b) => dist(a, from) - dist(b, from))[0];
  }

  async chooseDefenders(list: Officer[]): Promise<Officer[]> {
    const how = await this.io.choose(`${this.target.name}이(가) 공격받고 있다! 방어 편성은?`, [
      { value: 1, label: "자동 편성" }, { value: 2, label: "직접 고르기" },
    ], { columns: 2 });
    const auto = [...list].sort((a, b) => b.men - a.men).slice(0, MAX_UNITS);
    if (how !== 2) return auto;
    const chosen: Officer[] = [];
    let rest = [...list];
    while (rest.length && chosen.length < MAX_UNITS) {
      const opts: Option[] = rest.map((o, i) => ({ value: i + 1, label: `${o.name} 병${o.men} 무${o.war} 지${o.int}`, officer: o.id }));
      opts.unshift({ value: 0, label: chosen.length ? `편성 완료 (${chosen.map((o) => o.name).join(", ")})` : "자동 편성" });
      const v = await this.io.choose(`출전할 장수 (처음 고른 장수가 총대장, 최대 ${MAX_UNITS}명)`, opts, { columns: 1 });
      if (!v) break;
      chosen.push(rest[v - 1]);
      rest = rest.filter((_, i) => i !== v - 1);
    }
    return chosen.length ? chosen : auto;
  }

  // ── 조회 ──
  log(t: string) {
    if (this.watch) this.io.say(t);
  }
  up(side: Side) {
    return side.units.filter(isUp);
  }
  men(side: Side) {
    return this.up(side).reduce((a, u) => a + u.o.men, 0);
  }
  other(side: Side) {
    return side === this.atk ? this.def : this.atk;
  }
  sideOf(u: Unit) {
    return u.side === "atk" ? this.atk : this.def;
  }
  occupancy(): Map<number, SideKey> {
    const m = new Map<number, SideKey>();
    for (const u of [...this.up(this.atk), ...this.up(this.def)]) m.set(u.hex, u.side);
    return m;
  }
  unitAt(h: number): Unit | undefined {
    return [...this.up(this.atk), ...this.up(this.def)].find((u) => u.hex === h);
  }
  terrain(h: number) {
    return this.field.terrain[h - 1];
  }
  rainy() {
    return this.weather === "비" || this.weather === "눈";
  }

  // 원작 3333:03d2 — 전투력 = 무력×3 + 장비율 + 훈련 (장비율은 무장 수치로 대신한다)
  power(u: Unit): number {
    return u.o.war * 3 + Math.min(100, u.o.arm) + u.o.trn;
  }

  // 원작 지형계수(0xb376). 성 안의 부대를 공격하는 쪽은 5(손실 2배), 성 안에서 막는 쪽은 20(손실 절반).
  divisor(x: Unit, enemy: Unit, attacker: boolean): number {
    if (attacker && this.terrain(enemy.hex) === "castle") return SORTIE_DIV;
    const t = this.terrain(x.hex);
    if (t === "castle") return TERRAIN_DIV.castle + Math.round((this.target.forts - 50) / 5); // 성곽 수치 보정 [설계]: 90이면 +8
    return TERRAIN_DIV[t];
  }

  // 원작 3333:042a — X의 손실 = (상대 전투력 − X 전투력 + min(상대 병사, 난수 0~299)) × 10 ÷ 지형계수 ÷ 공격 수
  loss(x: Unit, enemy: Unit, attacker: boolean, count: number): number {
    const raw = ((this.power(enemy) - this.power(x) + Math.min(enemy.o.men, rand(0, 299))) * 10) / this.divisor(x, enemy, attacker) / count;
    return raw <= 0 ? rand(1, 30) : Math.round(raw);
  }

  mobility(u: Unit): number {
    return Math.floor((Math.max(1, u.o.trn) - 1) / 20) + 2; // 원작 3475:031e
  }

  // 부대 손실. 병사가 0이 되면 장수는 사로잡히거나 달아난다.
  hit(u: Unit, dmg: number, by: Side | null) {
    if (!isUp(u)) return;
    u.o.men = Math.max(0, u.o.men - Math.round(dmg));
    if (u.o.men > 0) return;
    void this.fx({ kind: "rout", from: u.hex, to: u.hex }, false);
    if (u.o.id !== "__militia" && by && chance(0.7)) {
      by.captives.push(u.o);
      this.log(`${u.o.name}의 부대가 무너지고 ${u.o.name}이(가) 사로잡혔다!`);
    } else {
      this.log(u.o.id === "__militia" ? "수비군이 흩어졌다." : `${u.o.name}의 부대가 무너졌다. ${u.o.name}은(는) 몸만 빠져나갔다.`);
      u.gone = true;
    }
  }

  lose(side: Side, why: string) {
    if (this.result) return;
    this.result = side.key === "atk" ? "def" : "atk";
    this.reason = why;
    this.log(why);
  }

  // ── 행동 ──
  // 원작 34aa:01b8 — 한 번의 교전. 양측이 동시에 손실을 입는다.
  // 보고 있는 전투에서만 연출한다. wait=false면 기다리지 않는다 (불길·궤멸처럼 덧붙는 효과)
  async fx(f: BattleFx, wait = true) {
    if (!this.watch || !this.io.battleFx) return;
    this.render();
    const p = this.io.battleFx(f);
    if (wait) await p;
  }

  async clash(a: Unit, t: Unit, count = 1, kind: "attack" | "charge" = "attack", first = true) {
    // 난이도: AI가 플레이어 부대를 공격하면 AI의 손실이 준다 (원작 0x33b3)
    const bonus = this.sideOf(t).player && !this.sideOf(a).player ? this.s.difficulty - 1 : 0;
    let lossA = this.loss(a, t, true, count + bonus);
    let lossT = this.loss(t, a, false, 1);
    if (a.side === "atk" && this.sea && this.day <= 2) lossA = Math.round(lossA * 1.25); // 상륙 직후 [설계]
    lossA = Math.min(a.o.men, lossA);
    lossT = Math.min(t.o.men, lossT);
    this.log(`${a.o.name}이(가) ${t.o.name}을(를) 공격! 적 ${lossT}명, 아군 ${lossA}명 손실.`);
    await this.fx({ kind, from: a.hex, to: t.hex, dmgTo: lossT, dmgFrom: lossA, first });
    this.hit(t, lossT, this.sideOf(a));
    this.hit(a, lossA, this.sideOf(t));
  }

  // 일기토 이벤트: 무력이 크게 앞서는 쪽이 도전한다 (원작 "I, Lu Bu, challenge you to combat!")
  async duelEvent(a: Unit, t: Unit): Promise<boolean> {
    if (t.o.id === "__militia" || a.o.id === "__militia" || Math.abs(a.o.war - t.o.war) < 10 || !chance(0.25)) return false;
    const [ch, foe] = t.o.war > a.o.war ? [t, a] : [a, t];
    await this.duel(ch, foe);
    return !isUp(a) || !isUp(t) || !!this.result;
  }

  // 1. 일반 공격
  async attack(a: Unit, t: Unit) {
    if (await this.duelEvent(a, t)) return;
    await this.clash(a, t);
  }

  // 2. 동시 공격: 대상에 붙은 아군 부대가 모두 함께 친다. 공격 수만큼 각자의 손실이 준다 (원작 35fd:00a2)
  allies(t: Unit, side: Side): Unit[] {
    return this.up(side).filter((x) => !x.done && dist(x.hex, t.hex) === 1);
  }

  async simultaneous(a: Unit, t: Unit) {
    const group = [a, ...this.allies(t, this.sideOf(a)).filter((x) => x !== a)];
    this.log(`${group.map((x) => x.o.name).join("·")}의 동시 공격!`);
    for (const x of group) {
      if (!isUp(t) || this.result) break;
      if (!isUp(x)) continue;
      await this.clash(x, t, group.length);
      x.done = true;
    }
  }

  // 4. 돌격: 난수 1~10회 연달아 친다. 적이 무너지면 그 칸으로 밀고 들어간다 (원작 35fd:0348)
  async charge(a: Unit, t: Unit) {
    if (await this.duelEvent(a, t)) return;
    const n = rand(1, 10);
    const target = t.hex;
    this.log(`${a.o.name}의 돌격! (${n}회)`);
    for (let i = 0; i < n && isUp(a) && isUp(t) && !this.result; i++) await this.clash(a, t, 1, "charge", i === 0);
    if (isUp(a) && !isUp(t) && !this.result && !this.unitAt(target) && !this.fires.has(target)) {
      a.hex = target;
      this.log(`${a.o.name}이(가) 적진으로 밀고 들어갔다.`);
      this.checkEnd();
    } else if (isUp(a) && isUp(t) && !this.result) this.push(a, t, false);
  }

  // 적 밀어내기 (원작 이동 메뉴 "2.Move enemy", 금 10)
  push(a: Unit, t: Unit, paid: boolean): boolean {
    const dir = [0, 1, 2, 3, 4, 5].find((d) => step(a.hex, d) === t.hex);
    const dest = dir === undefined ? null : step(t.hex, dir);
    const tt = dest ? this.terrain(dest) : null;
    if (!dest || this.unitAt(dest) || this.fires.has(dest) || tt === "mountain" || tt === "castle") {
      if (paid) this.log("적을 밀어낼 수 없다.");
      return false;
    }
    if (paid) this.sideOf(a).gold -= 10;
    t.hex = dest;
    this.log(`${t.o.name}의 부대가 뒤로 밀려났다.`);
    return true;
  }

  // 원작 3878 — 체력은 무력, 최대 10합. 약한 쪽은 무력 차 ÷ 5만큼 타격 상한이 줄어든다.
  async duel(a: Unit, b: Unit) {
    this.log(`"나 ${a.o.name}, ${b.o.name}에게 일기토를 청한다!"`);
    let accept: boolean;
    if (this.sideOf(b).player) accept = await this.io.confirm(`${a.o.name}(무력 ${a.o.war})이(가) 일기토를 청합니다. ${b.o.name}(무력 ${b.o.war}), 응하시겠습니까?`);
    else accept = b.o.war >= a.o.war - 10 || chance(0.3);
    if (!accept) {
      this.hit(b, b.o.men * 0.1, null);
      this.log(`"${b.o.name}은(는) 겁쟁이다!" 부대의 사기가 떨어진다.`);
      return;
    }
    this.log(`"${b.o.name}, 기꺼이 상대해 주마!" — 일기토`);
    await this.fx({ kind: "duel", from: a.hex, to: b.hex });
    const d = Math.floor(Math.abs(a.o.war - b.o.war) / 5);
    const ra = a.o.war >= b.o.war ? 20 : Math.max(2, 20 - d);
    const rb = b.o.war >= a.o.war ? 20 : Math.max(2, 20 - d);
    let ha = a.o.war;
    let hb = b.o.war;
    let round = 0;
    while (round < 10 && ha > 0 && hb > 0) {
      round++;
      hb -= rand(0, ra - 1);
      ha -= rand(0, rb - 1);
    }
    if (ha > 0 && hb > 0) {
      this.log(`… ${round}합을 겨뤘으나 승부가 나지 않았다. (무승부)`);
      return;
    }
    if (ha <= 0 && hb <= 0) {
      this.log(`… ${round}합 만에 두 장수가 함께 쓰러졌다!`);
      this.hit(a, a.o.men * 0.5, this.sideOf(b));
      this.hit(b, b.o.men * 0.5, this.sideOf(a));
      return;
    }
    const [win, lose] = hb <= 0 ? [a, b] : [b, a];
    this.log(`… ${round}합 만에 ${win.o.name}의 승리!`);
    if (win.o.war < lose.o.war) {
      const before = win.o.war;
      win.o.war = Math.floor((win.o.war + lose.o.war + 1) / 2); // 원작 3878:0d56
      this.log(`${win.o.name}의 무력이 ${before}에서 ${win.o.war}(으)로 올랐다!`);
    }
    const roll = Math.random();
    if (roll < 0.2) {
      this.log(`${lose.o.name}이(가) 전사했다!`);
      lose.o.men = 0;
      for (const t of killOfficer(this.s, lose.o)) this.io.say(t);
    } else if (roll < 0.55) {
      this.sideOf(win).captives.push(lose.o);
      lose.o.men = 0;
      this.log(`${lose.o.name}이(가) 사로잡혔다!`);
    } else {
      this.hit(lose, lose.o.men * 0.5, this.sideOf(win));
      if (isUp(lose)) this.log(`${lose.o.name}은(는) 간신히 진으로 달아났다.`);
    }
  }

  // 3. 화계 (원작 34aa:008c, 3333:035a): 지형 기본 확률 + 난수 0~9. 적이 있으면 양측 지력으로 보정. 비·눈에는 불가.
  fireChance(a: Unit, h: number): number {
    const t = this.terrain(h);
    if (this.rainy() || FIRE_BASE[t] === 0) return 0;
    const base = FIRE_BASE[t] + rand(0, 9);
    const e = this.unitAt(h);
    if (!e || e.side === a.side) return base;
    return Math.min(100, Math.floor(((101 - e.o.int) * base) / 100) + Math.floor(rand(0, Math.max(0, a.o.int - e.o.int)) / 2));
  }

  async fire(a: Unit, h: number) {
    const t = this.terrain(h);
    if (this.rainy()) {
      this.log(`${this.weather}이(가) 내려 불을 놓을 수 없다.`);
      return;
    }
    const target = this.unitAt(h);
    const ok = rand(0, 99) < this.fireChance(a, h);
    await this.fx({ kind: "fire", from: a.hex, to: h, ok });
    if (ok) {
      this.fires.set(h, 2 + (t === "forest" || t === "grass" ? 1 : 0));
      this.log(`${a.o.name}의 화계! ${TERRAIN_NAME[t]}에 불이 붙었다!`);
      if (target) this.burn(target);
    } else this.log(`${a.o.name}의 화계는 실패했다.`);
  }

  burn(u: Unit) {
    const before = u.o.men;
    const dmg = Math.round(u.o.men * (0.15 + Math.random() * 0.1));
    void this.fx({ kind: "burn", from: u.hex, to: u.hex, dmgTo: dmg }, false);
    this.hit(u, dmg, this.other(this.sideOf(u)));
    this.log(`불길이 ${u.o.name}의 부대를 덮쳤다! ${before - u.o.men}명 손실.`);
  }

  // 이간할 수 있는 적: 총대장·군주·수비군은 돌아서지 않는다
  canPlot(t: Unit): boolean {
    const foe = this.sideOf(t);
    return t !== foe.commander && t.o.id !== "__militia" && !(foe.faction && this.s.factions[foe.faction].ruler === t.o.id);
  }

  // 이간: 금 100으로 적 장수를 매수해 아군으로 돌린다 (원작 Gold 사용 추정)
  async plot(a: Unit, t: Unit) {
    if (!this.canPlot(t)) return;
    const side = this.sideOf(a);
    side.gold -= 100;
    const p = clamp((100 - t.o.loy) / 120 + (a.o.int - t.o.int) / 200 + 0.03, 0.03, 0.7);
    const ok = chance(p);
    await this.fx({ kind: "plot", from: a.hex, to: t.hex, ok });
    if (ok) {
      const foe = this.sideOf(t);
      foe.units = foe.units.filter((u) => u !== t);
      t.side = side.key;
      t.faction = side.faction;
      t.done = true;
      side.units.push(t);
      this.log(`${a.o.name}의 계략! ${t.o.name}이(가) 아군으로 돌아섰다!`);
    } else this.log(`${a.o.name}의 계략은 ${t.o.name}에게 통하지 않았다.`);
  }

  flee(u: Unit) {
    const side = this.sideOf(u);
    if (u === side.commander) {
      this.lose(side, `총대장 ${u.o.name}이(가) 퇴각을 명했다.`);
      return;
    }
    u.gone = true;
    this.log(`${u.o.name}의 부대가 전장을 떠났다.`);
  }

  // ── 날마다 ──
  newDay() {
    const m = this.s.month;
    const r = Math.random();
    const wet = m >= 6 && m <= 8 ? 0.3 : 0.15;
    this.weather = [12, 1, 2].includes(m) && r < 0.2 ? "눈" : r < wet ? "비" : r < wet + 0.25 ? "흐림" : "맑음";
    if (this.day === 1 || chance(0.3)) this.wind = chance(0.2) ? null : rand(0, 5);

    // 불: 피해, 바람 따라 번짐, 비에 꺼짐
    for (const [h, left] of [...this.fires]) {
      const u = this.unitAt(h);
      if (u) this.burn(u);
      if (this.rainy() && chance(0.7)) {
        this.fires.delete(h);
        continue;
      }
      if (this.wind !== null) {
        const n = step(h, this.wind);
        const t = n ? this.terrain(n) : null;
        if (n && t && !this.fires.has(n) && FIRE_BASE[t] >= 50 && t !== "castle" && chance((FIRE_BASE[t] / 100) * 0.6)) {
          this.fires.set(n, 2);
          const v = this.unitAt(n);
          if (v) this.burn(v);
        }
      }
      if (left <= 1) this.fires.delete(h);
      else this.fires.set(h, left - 1);
    }
  }

  checkEnd(): boolean {
    if (this.result) return true;
    const hq = this.unitAt(this.field.hq);
    if (hq?.side === "atk") this.lose(this.def, `${hq.o.name}이(가) 본성을 점령했다!`);
    else if (!this.up(this.atk).length) this.lose(this.atk, `${this.atk.label}의 부대가 모두 무너졌다.`); // 양군이 다 무너지면 공격 실패
    else if (!this.up(this.def).length) this.lose(this.def, `${this.def.label}의 부대가 모두 무너졌다.`);
    else {
      this.takeCommand(this.atk);
      this.takeCommand(this.def);
    }
    return !!this.result;
  }

  // 총대장이 자리를 비우면 출전 중인 자국 장수가 잇는다 [설계]. 원군과 돌아선 장수는 잇지 못한다.
  // 전장에서 무너진 경우에만 병사가 달아난다. 달 사이에 비었으면(자연사) commander가 null이다.
  takeCommand(side: Side) {
    const lost = side.commander;
    if (this.result || (lost && isUp(lost))) return;
    const pool = this.up(side).filter((u) => u.faction === side.faction && u.o.faction === side.faction);
    const pick = pickCommander(pool.map((u) => u.o), this.s, side.faction);
    const next = pool.find((u) => u.o === pick);
    if (!next) return this.lose(side, `${side.label}에는 군을 이을 장수가 없다.`);
    if (lost) {
      for (const u of this.up(side)) u.o.men = Math.max(1, u.o.men - Math.round(u.o.men * DESERT_RATE));
      this.log(`총대장을 잃자 ${side.label}의 병사 일부가 달아났다!`);
    }
    side.commander = next;
    this.log(`${side.label}의 새 총대장은 ${next.o.name}이다.`);
  }

  // ── 화면 ──
  sideView(side: Side): SideView {
    const ruler = side.faction ? this.s.factions[side.faction].ruler : null;
    return {
      label: side.label, ruler, men: this.men(side), generals: this.up(side).length, reserve: side.reserve.length,
      food: side.food, gold: side.gold,
    };
  }

  view(active?: Unit, highlight: number[] = [], targets: number[] = []): BattleView {
    const color = (f: FactionId | null) => (f ? FACTION_INFO[f] : { color: "#8d867a", ink: "#fff" });
    return {
      regionId: this.target.id, cols: COLS, rows: ROWS,
      hexes: this.field.terrain.map((terrain, i) => ({ id: i + 1, col: colOf(i + 1), row: rowOf(i + 1), terrain })),
      units: [...this.up(this.atk), ...this.up(this.def)].filter((u) => u.hex > 0).map((u) => {
        const c = color(u.faction);
        return {
          id: u.o.id, name: u.o.name, men: u.o.men, hex: u.hex, side: u.side, color: c.color, ink: c.ink,
          active: u === active, done: u.done, commander: u === this.atk.commander || u === this.def.commander, faction: u.faction,
        };
      }),
      hq: this.field.hq, castles: this.field.castles, fires: [...this.fires.keys()], entries: this.entries,
      title: `${this.target.name} 공방전`, day: this.day, maxDay: this.monthEnd,
      weather: this.weather, wind: this.wind === null ? "무풍" : `${DIR_ARROW[this.wind]} ${DIR_NAME[this.wind]}풍`,
      atk: this.sideView(this.atk), def: this.sideView(this.def), highlight, targets,
    };
  }

  render(active?: Unit, highlight?: number[], targets?: number[]) {
    if (this.watch) this.io.showBattle(this.view(active, highlight, targets));
  }

  reach(u: Unit) {
    return reachable(u.hex, this.mobility(u), this.field, this.occupancy(), u.side, new Set(this.fires.keys()), new Set(this.field.castles));
  }

  enemiesWithin(u: Unit, d: number) {
    return this.up(this.other(this.sideOf(u))).filter((e) => dist(u.hex, e.hex) <= d);
  }

  // ── AI ──
  async aiUnit(u: Unit) {
    const side = this.sideOf(u);
    const foe = this.other(side);
    const enemies = this.up(foe);
    if (!enemies.length) return;
    const hq = this.field.hq;
    const nearest = (from: number) => enemies.reduce((b, e) => (dist(from, e.hex) < dist(from, b.hex) ? e : b));
    const isCmd = u === side.commander;
    const hangBack = isCmd && this.up(side).length > 1; // 다른 부대가 있으면 총대장은 뒤에 선다

    // 위급하면 퇴각 (총대장 제외, 병력이 바닥난 부대)
    if (!isCmd && u.o.men < 300 && chance(0.5)) return this.flee(u);

    if (!this.enemiesWithin(u, 1).length && !(isCmd && u.side === "def" && u.hex === hq)) {
      const reach = this.reach(u);
      if (u.side === "atk" && !this.unitAt(hq) && reach.has(hq)) {
        u.hex = hq;
        return;
      }
      let goal = nearest(u.hex).hex;
      if (u.side === "def") {
        if (!this.unitAt(hq) && reach.has(hq)) {
          u.hex = hq;
          return;
        }
        // 수비측은 성을 지킨다: 성 안에 있으면 나가지 않고, 비어 있는 성이 닿으면 들어간다 [설계]
        if (this.terrain(u.hex) === "castle" && this.unitAt(hq)) return this.aiStrike(u);
        const freeCastle = this.field.castles.find((c) => !this.unitAt(c) && reach.has(c));
        if (freeCastle) {
          u.hex = freeCastle;
          return;
        }
        const threat = nearest(hq);
        if (dist(threat.hex, hq) > 5 || isCmd) goal = hq;
      } else if (hangBack) {
        // 공격측 총대장은 뒤에서 따라간다
        const front = this.up(side).filter((x) => x !== u);
        if (front.length) goal = front.reduce((b, x) => (dist(x.hex, hq) < dist(b.hex, hq) ? x : b)).hex;
      } else goal = this.unitAt(hq) ? this.unitAt(hq)!.hex : hq;
      const path = this.pathTo(goal, u.side);
      const far = (h: number) => path.get(h) ?? 1000 + dist(h, goal) * 10;
      let best = u.hex;
      let score = far(u.hex) * 5 - this.defenseAt(u.hex, u.side) * 3;
      for (const h of reach.keys()) {
        if (this.field.castles.includes(h) && u.side === "atk" && h !== hq) continue;
        const sc = far(h) * 5 - this.defenseAt(h, u.side) * 3 + (hangBack && this.enemyAdjacentTo(h, u.side) ? 15 : 0);
        if (sc < score) {
          score = sc;
          best = h;
        }
      }
      u.hex = best;
    }
    await this.aiStrike(u);
  }

  // 제자리에서 할 수 있는 행동: 이간·화계·동시 공격·돌격·공격
  async aiStrike(u: Unit) {
    const side = this.sideOf(u);
    const adj = this.enemiesWithin(u, 1);
    const plotTarget = this.enemiesWithin(u, 4).find((e) => this.canPlot(e) && e.o.loy < 60);
    if (plotTarget && side.gold >= 100 && u.o.int >= 75 && chance(0.2)) return this.plot(u, plotTarget);
    if (!adj.length) return;
    const t = adj.reduce((b, e) => (e.o.men < b.o.men ? e : b));
    if (!this.rainy() && u.o.int >= 70 && this.fireChance(u, t.hex) >= 60 && chance(0.4)) return this.fire(u, t.hex);
    if (this.allies(t, side).length >= 2 && chance(0.7)) return this.simultaneous(u, t);
    if (this.power(u) > this.power(t) + 30 && u.o.men > t.o.men && chance(0.35)) return this.charge(u, t);
    await this.attack(u, t);
  }

  // 목표까지 지형을 따라 걸어가는 비용 (부대는 무시). 직선거리로만 고르면 산·강 앞에서 더 가까운 칸이 없어 멈춰 버린다.
  pathTo(goal: number, side: SideKey): Map<number, number> {
    const key = `${goal}|${side}`;
    const hit = this.paths.get(key);
    if (hit) return hit;
    const cost = new Map<number, number>([[goal, 0]]);
    const queue: [number, number][] = [[goal, 0]];
    while (queue.length) {
      queue.sort((a, b) => a[1] - b[1]);
      const [cur, c] = queue.shift()!;
      if (c > (cost.get(cur) ?? Infinity)) continue;
      const t = this.terrain(cur);
      if (cur !== goal && (t === "mountain" || (t === "castle" && side === "atk"))) continue;
      for (const n of neighbors(cur)) {
        const nc = c + (cur === goal ? 2 : MOVE_COST[t]);
        if (nc < (cost.get(n) ?? Infinity)) {
          cost.set(n, nc);
          queue.push([n, nc]);
        }
      }
    }
    this.paths.set(key, cost);
    return cost;
  }

  enemyAdjacentTo(h: number, side: SideKey) {
    return neighbors(h).some((n) => {
      const v = this.unitAt(n);
      return v && v.side !== side;
    });
  }

  defenseAt(hex: number, side: SideKey): number {
    const t = this.terrain(hex);
    if (this.fires.has(hex)) return -5;
    if (t === "castle") return side === "def" ? 3 : 1.5;
    if (t === "river") return -1;
    return TERRAIN_DIV[t] / 10;
  }

  async aiPhase(side: Side) {
    const foe = this.other(side);
    const order = this.up(side).sort((a, b) => {
      const da = Math.min(...this.up(foe).map((e) => dist(a.hex, e.hex)));
      const db = Math.min(...this.up(foe).map((e) => dist(b.hex, e.hex)));
      return da - db;
    });
    for (const u of order) {
      if (this.checkEnd()) return;
      if (!isUp(u) || u.done) continue;
      await this.aiUnit(u);
      u.done = true;
      this.checkEnd();
    }
  }

  // ── 플레이어 지휘 (원작 메뉴: 1이동 2공격 3대기 4정보 5계략 6퇴각) ──
  async playerPhase(side: Side) {
    this.render();
    const mode = await this.io.choose(`${this.day}일째 (${this.weather}, ${this.view().wind}) — ${side.label}의 차례`, [
      { value: 1, label: "직접 지휘" }, { value: 2, label: "오늘은 맡김" },
      { value: 3, label: "끝까지 맡김" }, { value: 4, label: "전군 퇴각" },
    ], { columns: 4 });
    if (mode === 4) return this.lose(side, `${side.label}이(가) 전군 퇴각을 명했다.`);
    if (mode === 3) side.player = false;
    if (mode !== 1) return this.aiPhase(side);

    // 원군은 동맹국이 직접 움직인다
    for (const u of this.up(side).filter((x) => x.faction !== side.faction)) {
      if (this.checkEnd()) return;
      if (!isUp(u)) continue;
      await this.aiUnit(u);
      u.done = true;
    }
    if (this.checkEnd()) return;
    const units = this.up(side).filter((x) => !x.done);
    for (const u of units) {
      if (this.checkEnd()) return;
      if (!isUp(u) || u.done) continue;
      await this.commandUnit(u);
      u.done = true;
      this.render();
    }
  }

  async commandUnit(u: Unit) {
    const side = this.sideOf(u);
    for (;;) {
      if (this.checkEnd() || !isUp(u)) return;
      const reach = u.moved ? new Map<number, number>() : this.reach(u);
      const adj = this.enemiesWithin(u, 1);
      this.render(u, [...reach.keys()], adj.map((e) => e.hex));
      const opts: Option[] = [];
      if (reach.size) opts.push({ value: 1, label: "이동" });
      if (adj.length) opts.push({ value: 2, label: "공격" });
      opts.push({ value: 3, label: "대기" }, { value: 4, label: "정보" }, { value: 5, label: "계략" }, { value: 6, label: "퇴각" });
      const cmd = await this.io.choose(
        `${u.o.name}${u === side.commander ? "(총대장)" : ""} 병 ${u.o.men.toLocaleString("ko-KR")} — 명령은?`, opts, { columns: 6 },
      );
      if (cmd === 1) {
        // 원작 이동 메뉴: 1.Normal move 2.Move enemy
        if (adj.length && side.gold >= 10) {
          const how = await this.io.choose("이동", [{ value: 1, label: "일반 이동" }, { value: 2, label: "적 밀어내기 (금 10)" }], { cancel: true, columns: 2 });
          if (!how) continue;
          if (how === 2) {
            const t = await this.pickUnit(adj, "누구를 밀어냅니까?");
            if (t && this.push(u, t, true)) return;
            continue;
          }
        }
        const h = await this.io.pickHex(`어디로 이동합니까? (이동력 ${this.mobility(u)})`, [...reach.keys()], undefined, "취소");
        if (h) {
          u.hex = h;
          u.moved = true;
          if (this.checkEnd()) return;
        }
        continue;
      }
      if (cmd === 2) {
        // 원작 "Which attack? (1-4)": 1.Normal 2.Simultaneous 3.Fireball 4.Charge
        const multi = adj.some((e) => this.allies(e, side).length >= 2);
        const kinds: Option[] = [{ value: 1, label: "일반" }];
        if (multi) kinds.push({ value: 2, label: "동시 공격" });
        if (!this.rainy()) kinds.push({ value: 3, label: "화계" });
        kinds.push({ value: 4, label: "돌격" });
        const kind = await this.io.choose("어떤 공격입니까?", kinds, { cancel: true, columns: 4 });
        if (!kind) continue;
        const pool = kind === 2 ? adj.filter((e) => this.allies(e, side).length >= 2) : adj;
        let t: Unit | undefined;
        if (kind === 3) {
          const labels = Object.fromEntries(pool.map((e) => [e.hex, `${e.o.name} (성공률 약 ${this.fireChance(u, e.hex)}%)`]));
          this.render(u, [], pool.map((e) => e.hex));
          const h = await this.io.pickHex("불을 놓을 적 부대", pool.map((e) => e.hex), labels, "취소");
          t = pool.find((e) => e.hex === h);
        } else t = await this.pickUnit(pool, "누구를 공격합니까?");
        if (!t) continue;
        if (kind === 1) await this.attack(u, t);
        else if (kind === 2) await this.simultaneous(u, t);
        else if (kind === 3) await this.fire(u, t.hex);
        else await this.charge(u, t);
        return;
      }
      if (cmd === 3) return;
      if (cmd === 4) {
        const all = [...this.up(this.atk), ...this.up(this.def)];
        const t = await this.pickUnit(all, "누구를 봅니까?");
        if (t && t.o.id !== "__militia") {
          this.io.showOfficer(t.o.id, `${t.o.name} (${t.faction ? this.s.factions[t.faction].name : "토착"})`, [
            `병사 ${t.o.men.toLocaleString("ko-KR")} · 무력 ${t.o.war} · 지력 ${t.o.int} · 충성 ${t.o.loy}`,
            `훈련 ${t.o.trn} · 무장 ${t.o.arm} · 지형 ${TERRAIN_NAME[this.terrain(t.hex)]}`,
          ]);
        }
        continue;
      }
      if (cmd === 5) {
        const done = await this.strategy(u);
        if (done) return;
        continue;
      }
      if (cmd === 6) {
        const msg = u === side.commander ? "총대장이 물러나면 전투에서 집니다. 전군 퇴각합니까?" : `${u.o.name}의 부대를 퇴각시킵니까?`;
        if (await this.io.confirm(msg)) return this.flee(u);
      }
    }
  }

  async strategy(u: Unit): Promise<boolean> {
    const side = this.sideOf(u);
    const plotPool = this.enemiesWithin(u, 4).filter((e) => this.canPlot(e));
    const duelPool = this.enemiesWithin(u, 1).filter((e) => e.o.id !== "__militia");
    const opts: Option[] = [];
    if (plotPool.length && side.gold >= 100) opts.push({ value: 1, label: "이간 (금 100)" });
    if (duelPool.length) opts.push({ value: 2, label: "일기토" });
    if (!opts.length) {
      this.io.say("쓸 수 있는 계략이 없습니다. (화계는 공격 메뉴에 있습니다)");
      return false;
    }
    const v = await this.io.choose("계략", opts, { cancel: true, columns: 2 });
    if (v === 1) {
      const t = await this.pickUnit(plotPool, "누구를 회유합니까?");
      if (!t) return false;
      await this.plot(u, t);
      return true;
    }
    if (v === 2) {
      const t = await this.pickUnit(duelPool, "누구에게 일기토를 청합니까?");
      if (!t) return false;
      await this.duel(u, t);
      return true;
    }
    return false;
  }

  async pickUnit(pool: Unit[], prompt: string): Promise<Unit | undefined> {
    if (!pool.length) return undefined;
    if (pool.length === 1) return pool[0];
    const labels = Object.fromEntries(pool.map((e) => [e.hex, `${e.o.name} (${e.o.men})`]));
    this.render(undefined, [], pool.map((e) => e.hex));
    const h = await this.io.pickHex(prompt, pool.map((e) => e.hex), labels, "취소");
    return pool.find((e) => e.hex === h);
  }

  // 이번 달 전투가 끝나는 날 (30일씩 끊어 싸운다)
  monthEnd = MAX_DAYS;

  // 한 달(30일) 동안 싸운다. 승부가 나면 이긴 편, 아니면 null (다음 달로 이어짐)
  async runMonth(): Promise<SideKey | null> {
    this.monthEnd = this.day + MAX_DAYS - 1;
    this.render();
    for (; this.day <= this.monthEnd && !this.checkEnd(); this.day++) {
      for (const u of [...this.atk.units, ...this.def.units]) {
        u.done = false;
        u.moved = false;
      }
      this.newDay();
      if (this.watch) this.log(`── ${this.day}일째 · ${this.weather} · ${this.view().wind} ──`);
      if (this.checkEnd()) break;
      // 원작처럼 수비측이 먼저 움직인다
      for (const side of [this.def, this.atk]) {
        if (this.checkEnd()) break;
        if (side.player) await this.playerPhase(side);
        else await this.aiPhase(side);
        this.render();
      }
      if (this.checkEnd()) break;
      // 군량: 병사 1명당 한 달(30일)에 1석
      for (const side of [this.atk, this.def]) {
        side.food = Math.max(0, side.food - Math.ceil(this.men(side) / 30));
        if (side.food === 0) this.starve(side);
      }
      this.checkEnd();
      if (this.watch && !this.interactive) await this.io.sleep(200);
    }
    return this.result;
  }

  // 원작 3878:0f6a "men are deserting!" — 매일 모든 부대가 병사 5~9%를 잃는다. 반올림으로 끝없이 버티지 않게 최소 1명 [설계]
  starve(side: Side) {
    this.log(`${side.label}의 군량이 떨어져 병사들이 달아나고 있다!`);
    for (const u of this.up(side)) this.hit(u, Math.max(1, (u.o.men * rand(5, 9)) / 100), null);
  }

  // 달이 바뀔 때 공격측이 물러날지 정한다. 수비측은 성을 버릴 수 없다.
  async monthDecision(months: number) {
    const a = this.men(this.atk);
    const d = this.men(this.def);
    if (this.atk.player) {
      this.render();
      const go = await this.io.confirm(`${this.target.name} 포위 ${months}개월째 — 아군 ${a.toLocaleString("ko-KR")} · 적 ${d.toLocaleString("ko-KR")} · 군량 ${this.atk.food.toLocaleString("ko-KR")}. 포위를 계속합니까? (아니오 = 퇴각)`);
      if (!go) this.lose(this.atk, `${this.atk.label}이(가) 포위를 풀고 물러났다.`);
      return;
    }
    // AI: 병력이 크게 밀리거나, 군량이 열흘도 안 남았거나, 반년이 지나면 물러난다 [설계]
    const daily = Math.ceil(a / 30) || 1;
    if (a < d * 0.5 || this.atk.food < daily * 10 || months >= 6) this.lose(this.atk, `${this.atk.label}이(가) 포위를 풀고 물러났다.`);
  }

  // ── 달을 넘기는 저장·복원 ──
  save(months: number, arrivals: Arrival[] = []): OngoingBattle {
    const side = (sd: Side): SavedSide => ({
      faction: sd.faction,
      player: sd.player,
      units: sd.units.filter(isUp).map((u) => ({ id: u.o.id, faction: u.faction, hex: u.hex, home: u.home, men: u.o.id === "__militia" ? u.o.men : undefined })),
      reserve: sd.reserve.filter((o) => o.alive).map((o) => o.id),
      commander: sd.commander && isUp(sd.commander) ? sd.commander.o.id : null,
      food: sd.food, gold: sd.gold,
      captives: sd.captives.filter((o) => o.alive).map((o) => o.id),
    });
    return {
      target: this.target.id, from: this.from.id, attacker: this.atk.faction!, defender: this.def.faction,
      day: this.day, months, weather: this.weather, wind: this.wind, fires: [...this.fires],
      atk: side(this.atk), def: side(this.def), arrivals,
    };
  }

  static restore(s: GameState, io: IO, ob: OngoingBattle): Battle {
    const b = new Battle(s, io, regionOf(s, ob.from), regionOf(s, ob.target), ob.attacker, ob.defender);
    b.day = ob.day;
    b.weather = ob.weather as Weather;
    b.wind = ob.wind;
    b.fires = new Map(ob.fires);
    for (const [side, saved] of [[b.atk, ob.atk], [b.def, ob.def]] as const) {
      side.player = saved.player ?? side.player; // "끝까지 맡김"은 달이 바뀌어도 유지된다
      for (const su of saved.units) {
        const o = su.id === "__militia" ? { ...makeMilitia(b.target), men: su.men ?? 0 } : s.officers[su.id];
        if (!o || !o.alive || o.men <= 0) continue;
        side.units.push({ o, side: side.key, faction: su.faction, hex: su.hex, done: false, moved: false, gone: false, home: su.home });
      }
      side.reserve = saved.reserve.map((id) => s.officers[id]).filter((o) => o?.alive);
      // 포위 중에 성 안으로 들어온 장수도 수비측 예비로 친다
      if (side === b.def) for (const o of officersIn(s, b.target.id)) if (!side.reserve.includes(o)) side.reserve.push(o);
      side.captives = saved.captives.map((id) => s.officers[id]).filter((o) => o?.alive);
      side.food = saved.food;
      side.gold = saved.gold;
      // 총대장이 달 사이에 죽었으면 비워 둔다. 원군이 도착한 뒤 첫 checkEnd에서 새로 고른다
      side.commander = side.units.find((u) => u.o.id === saved.commander) ?? null;
    }
    // 수비측 창고는 지역 창고다 (그동안 거둔 곡식이 들어 있다)
    b.def.food = b.target.food;
    b.def.gold = b.target.gold;
    return b;
  }

  // 원군을 전장에 들인다. 공격측은 출발한 쪽 가장자리, 수비측은 성 둘레에 선다.
  placeArrivals(list: Arrival[]): Officer[] {
    const sent: Officer[] = [];
    const taken = new Set(this.up(this.atk).concat(this.up(this.def)).map((u) => u.hex));
    for (const a of list) {
      const side = a.side === "atk" ? this.atk : this.def;
      side.food += a.food;
      side.gold += a.gold;
      for (const id of a.officers) {
        const o = this.s.officers[id];
        if (!o?.alive || o.men <= 0) continue;
        if (this.up(side).length >= MAX_UNITS) {
          sent.push(o); // 자리가 없으면 돌려보낸다
          continue;
        }
        let h: number | undefined;
        if (a.side === "atk") {
          const edge = edgeFrom(a.from, this.target.id);
          h = entryHexes(this.field, edge).find((x) => !taken.has(x));
        } else {
          const f = this.field;
          h = [...f.castles, ...neighbors(f.hq), ...f.castles.flatMap(neighbors)].find((x) => !taken.has(x) && f.terrain[x - 1] !== "river");
        }
        h ??= this.nearestFree(a.side === "atk" ? this.entries[0] : this.field.hq, taken);
        taken.add(h);
        side.units.push({ o, side: side.key, faction: a.faction, hex: h, done: false, moved: false, gone: false, home: a.from });
        this.log(`${this.s.factions[a.faction].name}의 ${o.name}이(가) 원군으로 도착했다! (병사 ${o.men.toLocaleString("ko-KR")})`);
      }
    }
    return sent;
  }

  // 이 전투에 묶인 장수 모두
  involved(): Officer[] {
    return [...this.atk.units, ...this.def.units].map((u) => u.o).concat(this.def.reserve).filter((o) => o.id !== "__militia");
  }
}

// 돌아갈 곳: 집이 아직 자기 나라 땅이면 그대로, 아니면 수도로
function homeOf(s: GameState, o: Officer, home: number): number {
  if (o.faction && regionOf(s, home).owner === o.faction) return home;
  return (o.faction && capitalOf(s, o.faction)) || home;
}

// 출병: 새 전투를 연다
export async function war(s: GameState, io: IO, attacker: FactionId, fromId: number, targetId: number, order: WarOrder): Promise<boolean> {
  const from = regionOf(s, fromId);
  const target = regionOf(s, targetId);
  const defF = target.owner;
  from.food -= order.food;
  from.gold -= order.gold;
  const b = new Battle(s, io, from, target, attacker);
  b.atk.food = order.food;
  b.atk.gold = order.gold;
  for (const o of order.officers.slice(0, MAX_UNITS)) {
    b.atk.units.push({ o, side: "atk", faction: attacker, hex: 0, done: false, moved: false, gone: false, home: fromId });
  }
  b.atk.commander = b.atk.units[0] ?? null;

  if (defF) {
    if (isAllied(s, attacker, defF)) {
      breakAlliance(s, attacker, defF);
      io.say(`${b.atk.label}이(가) ${b.def.label}과(와)의 동맹을 깨뜨렸다!`);
    }
    changeRelation(s, attacker, defF, -20);
  }
  if (b.watch) {
    io.clear();
    io.say(`【출진】 ${b.atk.label}이(가) ${from.name}에서 ${target.name}${b.sea ? "(바닷길)" : ""}을(를) 공격한다!`);
  }
  io.event?.({ kind: "war" });
  await b.setup();
  b.log(`공격측 총대장 ${b.atk.commander?.o.name ?? "-"} · 수비측 총대장 ${b.def.commander?.o.name ?? "-"}`);
  for (const o of b.involved()) o.inBattle = targetId;
  return fight(s, io, b, 1);
}

// 매달 초: 이어지는 전투를 한 달씩 더 싸운다 (game.ts)
export async function resumeBattles(s: GameState, io: IO) {
  for (const ob of [...(s.battles ?? [])]) {
    s.battles = (s.battles ?? []).filter((x) => x !== ob);
    const target = regionOf(s, ob.target);
    // 공격국이 망했거나 지역 주인이 바뀌었으면 전투는 흐지부지 끝난다
    if (!s.factions[ob.attacker].alive || target.owner !== ob.defender) {
      releaseAll(s, ob);
      syncFlags(s);
      io.say(`${target.name}의 공방전은 흐지부지 끝났다.`);
      continue;
    }
    const b = Battle.restore(s, io, ob);
    if (b.watch) {
      io.clear();
      io.say(`【공방전 ${ob.months + 1}개월째】 ${b.atk.label}이(가) ${target.name}을(를) 계속 공격한다.`);
    }
    const back = b.placeArrivals(ob.arrivals);
    for (const o of back) {
      o.inBattle = undefined;
      o.region = homeOf(s, o, o.region);
    }
    for (const o of b.involved()) o.inBattle = ob.target;
    await fight(s, io, b, ob.months + 1);
  }
}

// 원군 보내기: 다음 달 전투에 합류한다. 장수는 지금부터 전장에 묶인다.
export function sendReinforcement(s: GameState, target: number, side: "atk" | "def", faction: FactionId, from: number, officers: Officer[], food: number, gold: number) {
  const ob = battleAt(s, target);
  if (!ob) return;
  const r = regionOf(s, from);
  r.food -= food;
  r.gold -= gold;
  for (const o of officers) o.inBattle = target;
  ob.arrivals.push({ side, faction, from, officers: officers.map((o) => o.id), food, gold });
}

// 한 달을 싸우고, 승부가 나면 정리하고, 아니면 저장해 다음 달로 넘긴다
async function fight(s: GameState, io: IO, b: Battle, months: number): Promise<boolean> {
  let res = await b.runMonth();
  if (!res) {
    await b.monthDecision(months);
    res = b.result;
  }
  if (res) {
    io.event?.({ kind: "battleEnd", atkWon: res === "atk", months });
    const won = await resolve(s, io, b);
    syncFlags(s);
    return won;
  }
  // 승부가 나지 않았다: 수비측 창고를 지역에 돌려놓고 다음 달로
  b.target.food = Math.min(MAX_FOOD, b.def.food);
  b.target.gold = Math.min(MAX_GOLD, b.def.gold);
  (s.battles ??= []).push(b.save(months));
  syncFlags(s);
  if (b.watch) {
    b.render();
    b.log(`${months}개월째 공방전이 끝나지 않았다. 다른 지역의 일을 보고 다음 달에 이어 싸운다. (원군을 보낼 수 있다)`);
    await io.pause("전투는 다음 달로 이어집니다. 계속하려면 아무 키나 누르십시오");
    io.showBattle(null);
  }
  return false;
}

// 이어지는 전투 어디에도 남지 않은 장수(전장을 떠났거나 무너진 부대 등)의 묶임을 풀고 집으로 보낸다
function syncFlags(s: GameState) {
  const held = new Set<string>();
  for (const ob of s.battles ?? []) {
    for (const sd of [ob.atk, ob.def]) {
      for (const u of sd.units) held.add(u.id);
      for (const id of [...sd.reserve, ...sd.captives]) held.add(id);
    }
    for (const a of ob.arrivals) for (const id of a.officers) held.add(id);
  }
  for (const o of Object.values(s.officers)) {
    if (!o.inBattle || held.has(o.id)) continue;
    o.inBattle = undefined;
    if (o.alive) o.region = homeOf(s, o, o.region);
  }
}

// 저장된 전투를 정리할 때 묶인 장수를 모두 풀어 준다
function releaseAll(s: GameState, ob: OngoingBattle) {
  for (const sd of [ob.atk, ob.def]) {
    for (const u of sd.units) {
      const o = s.officers[u.id];
      if (!o) continue;
      o.inBattle = undefined;
      if (o.alive) o.region = homeOf(s, o, u.home);
    }
    for (const id of sd.reserve) if (s.officers[id]) s.officers[id].inBattle = undefined;
  }
  for (const a of ob.arrivals) {
    for (const id of a.officers) {
      const o = s.officers[id];
      if (!o) continue;
      o.inBattle = undefined;
      if (o.alive) o.region = homeOf(s, o, a.from);
    }
  }
}

// 승부가 난 전투 정리: 점령·귀환·포로
async function resolve(s: GameState, io: IO, b: Battle): Promise<boolean> {
  const attacker = b.atk.faction!;
  const target = b.target;
  const targetId = target.id;
  const log = (t: string) => b.log(t);
  for (const o of b.involved()) o.inBattle = undefined;
  const atkWon = b.result === "atk";
  const winner = atkWon ? b.atk : b.def;
  const loser = atkWon ? b.def : b.atk;

  // 전투 중 돌아선 장수
  for (const side of [b.atk, b.def]) {
    for (const u of side.units) if (u.faction === side.faction && u.o.faction !== side.faction && u.o.id !== "__militia") {
      u.o.faction = side.faction;
      u.o.loy = rand(50, 65);
      u.home = side === b.atk ? homeOf(s, u.o, u.home) : targetId;
      u.o.region = u.home;
    }
  }
  // 수비측 군량·금은 지역 창고에서 썼다 (원군이 가져온 몫 포함, 창고 한도까지)
  target.food = Math.min(MAX_FOOD, b.def.food);
  target.gold = Math.min(MAX_GOLD, b.def.gold);

  const captives = [...winner.captives];
  // 진 쪽이 잡은 포로는 혼란 중에 풀려난다
  for (const c of loser.captives) if (c.alive) log(`${c.name}이(가) 혼란을 틈타 탈출했다.`);

  const inside = officersIn(s, targetId); // 성 안에 있던 수비측 장수 (예비에 없던 사람 포함)
  if (atkWon) {
    const prevOwner = target.owner;
    io.event?.({ kind: "capture", region: targetId, from: prevOwner, to: attacker });
    target.owner = attacker;
    target.delegated = false;
    target.loyalty = clamp(target.loyalty - 10, 0, 100);
    target.food = Math.min(MAX_FOOD, target.food + b.atk.food);
    target.gold = Math.min(MAX_GOLD, target.gold + b.atk.gold);
    for (const u of b.atk.units) {
      if (!u.o.alive || captives.includes(u.o) || b.def.captives.includes(u.o) || u.o.id === "__militia") continue;
      u.o.region = u.faction === attacker ? targetId : homeOf(s, u.o, u.home);
    }
    // 패한 수비 장수(출전·예비): 인접 아군 지역으로 도주하거나 포로가 된다
    const escape = prevOwner ? adjacent(targetId).filter((n) => regionOf(s, n).owner === prevOwner) : [];
    const losers = [...new Set([...b.def.units.filter((u) => u.faction === prevOwner).map((u) => u.o), ...b.def.reserve, ...inside])];
    for (const o of losers) {
      if (o.id === "__militia" || !o.alive || captives.includes(o) || o.faction !== prevOwner) continue;
      if (escape.length && chance(o.men > 0 ? 0.65 : 0.45)) {
        o.region = escape[rand(0, escape.length - 1)];
        log(`${o.name}은(는) ${regionOf(s, o.region).name}(으)로 달아났다.`);
      } else captives.push(o);
    }
    for (const u of b.def.units) if (u.faction !== prevOwner && u.o.alive && u.o.id !== "__militia") u.o.region = homeOf(s, u.o, u.home); // 원군 귀환
    if (b.watch) io.say(`${b.atk.label}이(가) ${target.name}을(를) 점령했다!`);
  } else {
    // 공격측은 각자 떠나온 곳으로 돌아간다. 남은 군량·금은 첫 출발지로
    const from = regionOf(s, homeOf(s, { faction: attacker } as Officer, b.from.id));
    if (from.owner === attacker) {
      from.food = Math.min(MAX_FOOD, from.food + b.atk.food);
      from.gold = Math.min(MAX_GOLD, from.gold + b.atk.gold);
    }
    for (const u of b.atk.units) {
      if (!u.o.alive || captives.includes(u.o) || u.o.id === "__militia") continue;
      u.o.region = homeOf(s, u.o, u.home);
    }
    for (const u of b.def.units) if (u.o.alive && u.faction !== b.def.faction && u.o.id !== "__militia") u.o.region = homeOf(s, u.o, u.home);
    if (b.watch) io.say(`${b.def.label}이(가) ${target.name}을(를) 지켜냈다.`);
  }

  const uniq = [...new Set(captives)].filter((c) => c.alive && c.id !== "__militia");
  if (uniq.length && winner.faction) await handleCaptives(s, io, winner, loser, uniq, targetId, log); // 이긴 쪽은 어느 경우든 목표 지역에 있다
  // 마지막 정리: 풀려난 포로 등 자기 나라 땅이 아닌 곳에 남은 장수는 집이나 수도로 돌아간다
  for (const o of [...b.involved(), ...b.atk.captives, ...b.def.captives]) {
    if (o.alive && o.faction && o.id !== "__militia" && regionOf(s, o.region).owner !== o.faction) o.region = homeOf(s, o, o.region);
  }
  for (const t of checkFactions(s)) io.say(t);
  if (b.watch) {
    b.render();
    await io.pause("전투가 끝났습니다. 계속하려면 아무 키나 누르십시오");
    io.showBattle(null);
  }
  return atkWon;
}

async function handleCaptives(
  s: GameState, io: IO, winner: Side, loser: Side, captives: Officer[], where: number,
  log: (t: string) => void,
) {
  const wf = winner.faction!;
  const rulerId = s.factions[wf].ruler;
  const rulerChr = rulerId ? s.officers[rulerId]?.chr ?? 60 : 60;
  const decide = s.factions[wf].player; // 위임 중이어도 포로 처분은 군주가 정한다
  for (const c of captives) {
    if (!c.alive || c.faction === wf) continue;
    const isRuler = !!c.faction && s.factions[c.faction].ruler === c.id;
    c.men = 0;
    let choice: number;
    if (decide) {
      io.showOfficer(c.id, `포로: ${c.name}${isRuler ? " — 적국의 군주!" : ""}`, [`지력 ${c.int} · 무력 ${c.war} · 매력 ${c.chr} · 충성 ${c.loy}`]);
      const opts = [{ value: 2, label: "석방" }, { value: 3, label: isRuler ? "폐위" : "유배" }];
      if (!isRuler) opts.unshift({ value: 1, label: "등용" });
      choice = (await io.choose(`${c.name}을(를) 어떻게 하시겠습니까?`, opts)) ?? 2;
    } else {
      choice = isRuler ? (chance(0.5) ? 3 : 2) : chance(0.75) ? 1 : chance(0.3) ? 3 : 2;
    }
    if (choice === 1) {
      const p = clamp((100 - c.loy) / 100 + (rulerChr - 50) / 200 + 0.15, 0.05, 0.9);
      if (chance(p)) {
        c.faction = wf;
        c.region = where;
        c.loy = rand(50, 70);
        log(`${c.name}이(가) ${s.factions[wf].name}에 귀순했다.`);
        continue;
      }
      log(`${c.name}: "두 임금을 섬길 수는 없소!" 등용을 거부했다.`);
      choice = decide ? ((await io.confirm(`${c.name}을(를) 유배 보내시겠습니까?`)) ? 3 : 2) : chance(0.3) ? 3 : 2;
    }
    if (choice === 3) {
      // 유배: 세력에서 떼어 재야로 보낸다. 군주라면 나라는 후계에게 넘어간다
      const home = c.faction;
      if (home && loser.faction) changeRelation(s, wf, loser.faction, -10);
      c.faction = null;
      c.hidden = false;
      c.region = where;
      log(`${c.name}을(를) ${isRuler ? "폐위해 " : ""}먼 곳으로 유배 보냈다.`);
      if (isRuler && home) for (const t of succeed(s, home, c, true)) io.say(t);
    } else {
      const home = c.faction && s.factions[c.faction].alive ? capitalOf(s, c.faction) : null;
      if (home) {
        c.region = home;
        log(`${c.name}을(를) 풀어 주었다. ${regionOf(s, home).name}(으)로 돌아갔다.`);
      } else {
        c.faction = null;
        c.hidden = false;
        log(`${c.name}을(를) 풀어 주었다. 재야로 떠났다.`);
      }
    }
  }
}
