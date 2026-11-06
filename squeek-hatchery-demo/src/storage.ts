import { freshSession, type Session } from "./rules.ts";
export interface DemoCard {
  id: string;
  kind: "egg" | "hamster";
  name: string;
  session: Session;
  svg?: string;
  metadata?: string;
}
export interface DemoStore {
  version: 3;
  selected: string | null;
  cards: DemoCard[];
}
export const STORE = "squeek-hatchery-v3";
const num = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function validSession(s: unknown): s is Session {
  const v = s as Session;
  return (
    !!v &&
    v.version === 3 &&
    typeof v.id === "string" &&
    /^[\w-]{1,100}$/.test(v.id) &&
    num(v.elapsed, 0, 60) &&
    num(v.lampPosition, -100, 100) &&
    Array.isArray(v.regions) &&
    v.regions.length === 3 &&
    v.regions.every(
      (r) => !!r && num(r.growth, 0, 1) && num(r.exposure, 0, 60.1),
    ) &&
    Array.isArray(v.bands) &&
    v.bands.length === 22 &&
    v.bands.every(
      (b, i) =>
        !!b &&
        num(b.y, 100 + i * 12, 100 + i * 12) &&
        num(b.dose, 0, 40) &&
        num(b.rainbow, 0, 1) &&
        num(b.pearl, 0, 1) &&
        Array.isArray(b.rgb) &&
        b.rgb.length === 3 &&
        b.rgb.every((c) => num(c, 0, 255)),
    ) &&
    Number.isInteger(v.accessoryId) &&
    num(v.accessoryId, 0, 11) &&
    v.accessoryVersion === 1 &&
    Array.isArray(v.colorsSeen) &&
    v.colorsSeen.every((c) => typeof c === "string" && c.length < 40) &&
    typeof v.workDuring === "string" &&
    /^\d{1,78}$/.test(v.workDuring) &&
    (v.accessorySource === null ||
      (!!v.accessorySource &&
        typeof v.accessorySource.counterEpoch === "string" &&
        /^\d{1,78}$/.test(v.accessorySource.cumulativeWorkUnits) &&
        /^\d{1,78}$/.test(v.accessorySource.bucket))) &&
    (v.endedAt === null || typeof v.endedAt === "string") &&
    (v.startedAt === null || typeof v.startedAt === "string")
  );
}
export function loadDemo(): DemoStore {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "null");
    if (v?.version === 3 && Array.isArray(v.cards))
      return {
        version: 3,
        selected: typeof v.selected === "string" ? v.selected : null,
        cards: v.cards.filter(
          (c: DemoCard) =>
            typeof c.id === "string" &&
            typeof c.name === "string" &&
            (c.kind === "egg" || c.kind === "hamster") &&
            validSession(c.session),
        ),
      };
  } catch {
    /* empty, explicit recovery in app */
  }
  return { version: 3, selected: null, cards: [] };
}
export function saveDemo(v: DemoStore) {
  localStorage.setItem(STORE, JSON.stringify(v));
}
export const selectedCard = (v: DemoStore) =>
  v.cards.find((c) => c.id === v.selected);
export function addDemoEgg(v: DemoStore) {
  const active = v.cards.find((c) => c.kind === "egg");
  if (active) {
    v.selected = active.id;
    return active;
  }
  const session = freshSession();
  const card: DemoCard = {
    id: session.id,
    kind: "egg",
    name: "Demo egg",
    session,
  };
  v.cards.push(card);
  v.selected = card.id;
  return card;
}
/** Web Locks are browser-provided atomic origin locks, held for the whole incubation. */
export async function withDemoLock(fn: () => void | Promise<void>) {
  if (!navigator.locks)
    throw new Error(
      "This browser needs Web Locks on HTTPS to protect your hatch. Use a current browser.",
    );
  return navigator.locks.request(
    "squeek-hatchery-incubation",
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error(
          "An incubation is open in another tab. Finish it there first.",
        );
      return fn();
    },
  );
}
