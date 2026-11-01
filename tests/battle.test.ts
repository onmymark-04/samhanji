// 전술 전투 회귀 테스트: 행동 중복, 군주 이간, 총대장 상실, 달을 넘기는 지휘 설정
import { describe, expect, it, vi } from "vitest";
import { seedRandom } from "../src/dev/seed";
import { Battle } from "../src/engine/battle";
import { dist, neighbors } from "../src/engine/hex";
import type { IO, Option } from "../src/engine/io";
import { createGame, officersIn } from "../src/engine/state";
import type { Officer } from "../src/engine/types";

const quietIO = (choice = 1): IO => ({
  say() {}, clear() {}, table() {}, refresh() {}, showOfficer() {}, showBattle() {},
  pause: async () => {}, sleep: async () => {},
  choose: async (_p: string, o: Option[]) => (o.some((x) => x.value === choice) ? choice : o[0].value),
  number: async (_p, min) => min,
  confirm: async () => true,
  pickRegion: async () => null,
  pickHex: async (_p, a) => a[0] ?? null,
});

// 신라군 둘이 백제 부대 하나에 붙어 있는 전장
function field(io: IO) {
  const s = createGame(1, ["silla"], "history", 2, false);
  const mine = s.regions.find((r) => r.owner === "silla" && officersIn(s, r.id).length >= 2)!;
  const foeRegion = s.regions.find((r) => r.owner === "baekje" && officersIn(s, r.id).length >= 2)!;
  const b = new Battle(s, io, mine, foeRegion, "silla", "baekje");
  const unit = (o: Officer, side: "atk" | "def", hex: number) => ({ o, side, faction: o.faction, hex, done: false, moved: false, gone: false, home: o.region });
  const [a1, a2] = officersIn(s, mine.id);
  const [d1, d2] = officersIn(s, foeRegion.id);
  for (const o of [a1, a2, d1, d2]) { o.men = 3000; o.inBattle = foeRegion.id; }
  const center = neighbors(100).length === 6 ? 100 : 101;
  const [h1, h2] = neighbors(center);
  const [u1, u2] = [unit(a1, "atk", h1), unit(a2, "atk", h2)];
  const [t1, t2] = [unit(d1, "def", center), unit(d2, "def", neighbors(center)[4])];
  b.atk.units.push(u1, u2);
  b.def.units.push(t1, t2);
  b.atk.commander = u1;
  b.def.commander = t1;
  return { s, b, u1, u2, t1, t2 };
}

describe("동시 공격", () => {
  it("함께 친 부대는 같은 날 다시 명령을 받지 않는다", async () => {
    const restore = seedRandom(3);
    try {
      const { b, u1, t1 } = field(quietIO());
      const called: string[] = [];
      b.commandUnit = async (u) => {
        called.push(u.o.name);
        await b.simultaneous(u, t1);
      };
      await b.playerPhase(b.atk);
      expect(called).toEqual([u1.o.name]);
    } finally {
      restore();
    }
  });

  it("이미 행동한 부대는 동시 공격에 끼지 못한다", () => {
    const { b, u1, u2, t1 } = field(quietIO());
    expect(b.allies(t1, b.atk)).toEqual([u1, u2]);
    u2.done = true;
    expect(b.allies(t1, b.atk)).toEqual([u1]);
  });
});

describe("이간", () => {
  it("군주·총대장은 이간할 수 없고 일반 장수는 할 수 있다", async () => {
    const { s, b, u1, t1, t2 } = field(quietIO());
    expect(b.canPlot(t1)).toBe(false);
    expect(b.canPlot(t2)).toBe(true);
    s.factions.baekje.ruler = t2.o.id;
    expect(b.canPlot(t2)).toBe(false);
    const gold = (b.atk.gold = 500);
    await b.plot(u1, t2);
    expect(b.atk.gold).toBe(gold); // 실행 함수도 막는다
    expect(t2.side).toBe("def");
  });
});

describe("총대장 상실", () => {
  // 부대를 무너뜨린다. 전투 코드는 다음 checkEnd에서 뒷일을 처리한다
  const rout = (b: Battle, u: ReturnType<typeof field>["t1"]) => b.hit(u, u.o.men, null);

  it("전투는 이어지고 남은 부대가 20%를 잃으며 다음 장수가 잇는다", () => {
    const { b, t1, t2 } = field(quietIO());
    rout(b, t1);
    expect(b.checkEnd()).toBe(false);
    expect(b.result).toBeNull();
    expect(b.def.commander).toBe(t2);
    expect(t2.o.men).toBe(2400);
  });

  it("같은 붕괴로 두 번 이탈하지 않는다", () => {
    const { b, t1, t2 } = field(quietIO());
    rout(b, t1);
    b.checkEnd();
    b.checkEnd();
    expect(t2.o.men).toBe(2400);
  });

  it("이탈만으로 부대가 사라지지 않고, 무너진 부대는 되살아나지 않는다", () => {
    const { b, t1, t2 } = field(quietIO());
    t2.o.men = 1;
    rout(b, t1);
    b.checkEnd();
    expect(t2.o.men).toBe(1);
    expect(t1.o.men).toBe(0);
  });

  it("일기토에서 전사하거나 사로잡혀도 전투는 이어진다", async () => {
    for (const roll of [0.1, 0.4]) {
      const { b, u1, t1, t2 } = field(quietIO());
      u1.o.war = 100;
      t1.o.war = 1;
      b.def.player = true; // 일기토를 받아들인다
      const spy = vi.spyOn(Math, "random").mockReturnValue(roll);
      await b.duel(u1, t1);
      spy.mockRestore();
      expect(b.checkEnd()).toBe(false);
      expect(b.def.commander).toBe(t2);
      expect(t2.o.men).toBe(2400);
    }
  });

  it("일기토에서 살아 돌아온 총대장은 자리를 지킨다", async () => {
    const { b, u1, t1, t2 } = field(quietIO());
    u1.o.war = 100;
    t1.o.war = 1;
    b.def.player = true; // 일기토를 받아들인다
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.9);
    await b.duel(u1, t1);
    spy.mockRestore();
    b.checkEnd();
    expect(t1.o.men).toBe(1500);
    expect(b.def.commander).toBe(t1);
    expect(t2.o.men).toBe(3000);
  });

  it("군주가 있으면 군주가, 없으면 능력 합이 높은 장수가 잇는다", () => {
    const { s, b, t1, t2 } = field(quietIO());
    const o = Object.values(s.officers).find((x) => x.faction === "baekje" && x !== t1.o && x !== t2.o)!;
    o.men = 3000;
    const t3 = { ...t2, o, hex: neighbors(t2.hex)[0] };
    b.def.units.push(t3);
    t2.o.war = 1; t2.o.int = 1; t2.o.chr = 1;
    o.war = 90; o.int = 90; o.chr = 90;
    rout(b, t1);
    b.checkEnd();
    expect(b.def.commander).toBe(t3);

    const f2 = field(quietIO());
    f2.s.factions.baekje.ruler = f2.t2.o.id;
    rout(f2.b, f2.t1);
    f2.b.checkEnd();
    expect(f2.b.def.commander).toBe(f2.t2);
  });

  it("동맹 원군이나 돌아선 장수만 남으면 패배한다", () => {
    const ally = field(quietIO());
    ally.t2.faction = "goguryeo";
    rout(ally.b, ally.t1);
    ally.b.checkEnd();
    expect(ally.b.result).toBe("atk");

    const turned = field(quietIO());
    turned.t2.o.faction = "silla";
    rout(turned.b, turned.t1);
    turned.b.checkEnd();
    expect(turned.b.result).toBe("atk");
  });

  it("양쪽 총대장이 함께 무너지면 양쪽 다 승계한다", () => {
    const { b, u1, u2, t1, t2 } = field(quietIO());
    rout(b, u1);
    rout(b, t1);
    expect(b.checkEnd()).toBe(false);
    expect(b.atk.commander).toBe(u2);
    expect(b.def.commander).toBe(t2);
  });

  it("양군이 모두 무너지면 공격 실패다", () => {
    const { b, u1, u2, t1, t2 } = field(quietIO());
    for (const u of [u1, u2, t1, t2]) rout(b, u);
    b.checkEnd();
    expect(b.result).toBe("def");
  });

  it("달 사이 자연사는 이탈 없이 승계한다", () => {
    const { s, b, t1, t2 } = field(quietIO());
    const ob = b.save(1);
    t1.o.alive = false;
    const next = Battle.restore(s, quietIO(), ob);
    expect(next.checkEnd()).toBe(false);
    expect(next.def.commander?.o).toBe(t2.o);
    expect(t2.o.men).toBe(3000);
  });

  it("승계 뒤 저장했다 복원해도 다시 이탈하지 않는다", () => {
    const { s, b, t1, t2 } = field(quietIO());
    rout(b, t1);
    b.checkEnd();
    const next = Battle.restore(s, quietIO(), b.save(1));
    next.checkEnd();
    expect(next.def.commander?.o).toBe(t2.o);
    expect(t2.o.men).toBe(2400);
  });

  it("총대장의 퇴각 명령은 그대로 패배다", () => {
    const { b, t1 } = field(quietIO());
    b.flee(t1);
    expect(b.result).toBe("atk");
  });

  it("원군이 총대장을 무너뜨리면 다음 원군이 움직이기 전에 승계한다", async () => {
    const { s, b, u1, u2, t1, t2 } = field(quietIO());
    const o = Object.values(s.officers).find((x) => x.faction === "tang")!;
    o.men = 3000;
    const u3 = { ...u1, o, faction: "tang" as const, hex: neighbors(u1.hex)[0] };
    b.atk.units.push(u3);
    u1.faction = "tang";
    b.atk.commander = u2;
    const seen: unknown[] = [];
    b.aiUnit = async (u) => {
      if (u === u1) rout(b, t1);
      else seen.push(b.def.commander);
    };
    b.commandUnit = async () => {};
    await b.playerPhase(b.atk);
    expect(seen).toEqual([t2]);
  });
});

describe("빈 본성과 군량", () => {
  it("수비 AI는 다른 성에 머무르지 않고 빈 본성으로 간다", async () => {
    const { b, u1, u2, t1, t2 } = field(quietIO());
    const hq = b.field.hq;
    const far = neighbors(neighbors(neighbors(hq)[0])[0]).find((h) => dist(h, hq) === 3)!;
    b.field.terrain[far - 1] = "castle";
    b.field.castles.push(far);
    t2.hex = far;
    t1.gone = true;
    t1.hex = 1;
    u1.hex = 1; // 적은 멀리 있다
    u2.hex = 2;
    await b.aiUnit(t2);
    expect(dist(t2.hex, hq)).toBeLessThan(3);
  });

  it("군량 이탈은 병사가 적어도 줄어든다", () => {
    const { b, u1, u2 } = field(quietIO());
    u1.o.men = 5;
    u2.o.men = 1;
    b.starve(b.atk);
    expect(u1.o.men).toBe(4);
    expect(u2.o.men).toBe(0);
  });
});

describe("끝까지 맡김", () => {
  it("저장했다 복원해도 유지되고, 맡기지 않은 쪽은 그대로다", () => {
    const { s, b } = field(quietIO());
    b.atk.player = false;
    const io = quietIO();
    expect(Battle.restore(s, io, b.save(1)).atk.player).toBe(false);
    b.atk.player = true;
    expect(Battle.restore(s, io, b.save(1)).atk.player).toBe(true);
  });

  it("예전 저장에는 값이 없어도 세력으로 정해진다", () => {
    const { s, b } = field(quietIO());
    const ob = b.save(1);
    delete ob.atk.player;
    expect(Battle.restore(s, quietIO(), ob).atk.player).toBe(true);
  });
});
