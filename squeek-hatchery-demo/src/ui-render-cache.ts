/**
 * UI reuse decisions for portraits, docs previews, leaderboard nodes, and controls.
 * Drawing and DOM application stay in the app; this module only decides what must change.
 */

export interface PortraitVisualInput {
  family: number;
  regionFamilies?: readonly number[] | null;
  levels: readonly number[];
  palette: number;
  accessory: number;
  background: number;
  staticOnly?: boolean;
}

/** Identity of pixels a portrait draw would produce. Lamp, elapsed, route, and telemetry are not inputs. */
export function portraitVisualKey(input: PortraitVisualInput): string {
  const regions = input.regionFamilies ?? [-1, -1, -1];
  return [
    input.family,
    regions.join(","),
    input.levels.join(","),
    input.palette,
    input.accessory,
    input.background,
    input.staticOnly ? "static" : "live",
  ].join("|");
}

export interface PortraitDrawInput {
  previousKey: string | null;
  nextKey: string;
  routeVisible: boolean;
  canvasFullyHidden: boolean;
  /** Hidden incubation canvas is still sampled for the lit interior. */
  pixelsSampledWhileHidden: boolean;
}

/**
 * Returns whether the expensive portrait draw has to run.
 * A null previous key still draws the first time pixels are actually needed.
 * An unchanged key never draws; accessory motion restarts without rebuilding pixels.
 */
export function shouldDrawPortrait(input: PortraitDrawInput): boolean {
  if (!input.routeVisible) return false;
  const pixelsNeeded = !input.canvasFullyHidden || input.pixelsSampledWhileHidden;
  if (!pixelsNeeded) return false;
  return input.previousKey === null || input.previousKey !== input.nextKey;
}

export interface AccessoryResumeInput {
  previousKey: string | null;
  nextKey: string;
  routeVisible: boolean;
  canvasFullyHidden: boolean;
  animating: boolean;
  accessoryAnimates: boolean;
}

/** Restart a stopped accessory loop only when the portrait pixels are already current. */
export function shouldResumeAccessoryAnimation(input: AccessoryResumeInput): boolean {
  return (
    input.routeVisible &&
    !input.canvasFullyHidden &&
    input.accessoryAnimates &&
    !input.animating &&
    input.previousKey !== null &&
    input.previousKey === input.nextKey
  );
}

export interface CancelableSchedule {
  cancel(): void;
}

export interface PreviewJobQueue {
  enqueue(job: () => void): void;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  readonly pending: number;
}

/** Runs at most one queued job per scheduler turn. Pause keeps the remaining jobs. */
export function createPreviewJobQueue(
  schedule: (run: () => void) => CancelableSchedule,
): PreviewJobQueue {
  let paused = false;
  let pending: Array<() => void> = [];
  let timer: CancelableSchedule | null = null;

  function arm(): void {
    if (paused || timer || pending.length === 0) return;
    timer = schedule(() => {
      timer = null;
      if (paused) return;
      const job = pending.shift();
      try {
        job?.();
      } finally {
        arm();
      }
    });
  }

  return {
    get paused() {
      return paused;
    },
    get pending() {
      return pending.length;
    },
    enqueue(job: () => void) {
      pending.push(job);
      arm();
    },
    pause() {
      paused = true;
      timer?.cancel();
      timer = null;
    },
    resume() {
      paused = false;
      arm();
    },
  };
}

export interface ScheduledPreview {
  id: string;
  visualKey: string;
}

export interface ScheduledPreviewHost {
  prepare(preview: ScheduledPreview): void | Promise<void>;
  paint(preview: ScheduledPreview): void;
  stop(preview: ScheduledPreview): void;
}

export interface ScheduledPreviewGallery {
  install(previews: readonly ScheduledPreview[]): boolean;
  readonly installed: boolean;
  open(): void;
  hide(): void;
  paintedKey(id: string): string | null;
  readonly pending: number;
}

/**
 * Builds a preview list once. Opening spreads prepare/paint across scheduler slices.
 * Hiding pauses the queue and stops started previews; reopening continues unfinished
 * work and does not paint an id whose visual key is already committed.
 */
export function createScheduledPreviewGallery(
  schedule: (run: () => void) => CancelableSchedule,
  host: ScheduledPreviewHost,
): ScheduledPreviewGallery {
  const queue = createPreviewJobQueue(schedule);
  let previews: ScheduledPreview[] = [];
  let installed = false;
  let active = false;
  const phases = new Map<string, "idle" | "loading" | "ready" | "painted">();
  const painted = new Map<string, string>();
  const queued = new Set<string>();

  function enqueue(preview: ScheduledPreview): void {
    if (queued.has(preview.id)) return;
    queued.add(preview.id);
    queue.enqueue(() => step(preview));
  }

  function enqueueMissing(): void {
    if (!active || !installed) return;
    for (const preview of previews) {
      if (painted.get(preview.id) === preview.visualKey) continue;
      if ((phases.get(preview.id) ?? "idle") === "loading") continue;
      enqueue(preview);
    }
  }

  function step(preview: ScheduledPreview): void {
    queued.delete(preview.id);
    if (!active) {
      host.stop(preview);
      return;
    }
    if (painted.get(preview.id) === preview.visualKey) return;
    const phase = phases.get(preview.id) ?? "idle";
    if (phase === "ready") {
      host.paint(preview);
      phases.set(preview.id, "painted");
      painted.set(preview.id, preview.visualKey);
      return;
    }
    if (phase === "loading" || phase === "painted") return;
    phases.set(preview.id, "loading");
    let preparation: void | Promise<void>;
    try {
      preparation = host.prepare(preview);
    } catch {
      phases.set(preview.id, "idle");
      if (active) enqueue(preview);
      return;
    }
    void Promise.resolve(preparation)
      .then(() => {
        if (phases.get(preview.id) !== "loading") return;
        phases.set(preview.id, "ready");
        if (active) enqueue(preview);
      })
      .catch(() => {
        if (phases.get(preview.id) === "loading") phases.set(preview.id, "idle");
        if (active) enqueue(preview);
      });
  }

  return {
    install(next: readonly ScheduledPreview[]): boolean {
      if (installed) return false;
      previews = next.map((preview) => ({ id: preview.id, visualKey: preview.visualKey }));
      installed = true;
      return true;
    },
    get installed() {
      return installed;
    },
    open() {
      active = true;
      queue.resume();
      enqueueMissing();
    },
    hide() {
      active = false;
      queue.pause();
      for (const preview of previews) {
        if ((phases.get(preview.id) ?? "idle") !== "idle") host.stop(preview);
      }
    },
    paintedKey(id: string) {
      return painted.get(id) ?? null;
    },
    get pending() {
      return queue.pending;
    },
  };
}

/** One preview step per animation frame, or one idle slice when the browser offers it. */
export function browserPreviewScheduler(run: () => void): CancelableSchedule {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(() => run(), { timeout: 32 });
    return { cancel: () => window.cancelIdleCallback(id) };
  }
  const id = window.requestAnimationFrame(() => run());
  return { cancel: () => window.cancelAnimationFrame(id) };
}

export interface LeaderboardPortraitIdentity {
  resultId: string;
  visualKey: string;
}

export interface LeaderboardPortraitPlan {
  reuse: string[];
  redraw: string[];
  dispose: string[];
}

/** Keeps identical leaderboard portraits, redraws visual edits, and drops removed entries. */
export function planLeaderboardPortraits(
  previous: readonly LeaderboardPortraitIdentity[],
  next: readonly LeaderboardPortraitIdentity[],
): LeaderboardPortraitPlan {
  const previousKeys = new Map(previous.map((item) => [item.resultId, item.visualKey]));
  const nextIds = new Set(next.map((item) => item.resultId));
  const reuse: string[] = [];
  const redraw: string[] = [];
  const dispose: string[] = [];
  for (const item of next) {
    const oldKey = previousKeys.get(item.resultId);
    if (oldKey === undefined || oldKey !== item.visualKey) redraw.push(item.resultId);
    else reuse.push(item.resultId);
  }
  for (const item of previous) {
    if (!nextIds.has(item.resultId)) dispose.push(item.resultId);
  }
  return { reuse, redraw, dispose };
}

export function leaderboardResponseIsCurrent(
  requestGeneration: number,
  latestGeneration: number,
  routeIsLeaderboard: boolean,
): boolean {
  return requestGeneration === latestGeneration && routeIsLeaderboard;
}

export interface StableControlSpec {
  id: string;
  tag: "button" | "span";
  present: boolean;
  text: string;
  className: string;
  disabled: boolean;
  html?: string;
  attrs?: Readonly<Record<string, string>>;
}

export type StableControlAction =
  | { op: "remove"; id: string }
  | { op: "create"; spec: StableControlSpec }
  | { op: "update"; spec: StableControlSpec };

/**
 * Present controls that already exist are updates, so a press that spans a tick
 * mouseups on the same element. A control is removed only when it should disappear.
 */
export function stableControlActions(
  currentIds: readonly string[],
  specs: readonly StableControlSpec[],
): StableControlAction[] {
  const wanted = new Set(specs.filter((spec) => spec.present).map((spec) => spec.id));
  const current = new Set(currentIds);
  const actions: StableControlAction[] = [];
  for (const id of currentIds) {
    if (!wanted.has(id)) actions.push({ op: "remove", id });
  }
  for (const spec of specs) {
    if (!spec.present) continue;
    actions.push(current.has(spec.id) ? { op: "update", spec } : { op: "create", spec });
  }
  return actions;
}

export interface StableControlHost {
  ids(): readonly string[];
  create(spec: StableControlSpec): void;
  update(id: string, spec: StableControlSpec): void;
  remove(id: string): void;
  /** Place a control created in this pass. Already-attached controls are never placed again. */
  placeNew(id: string, beforeId: string | null): void;
}

function nextAttachedSibling(
  specs: readonly StableControlSpec[],
  id: string,
  attachedIds: readonly string[],
): string | null {
  const present = specs.filter((spec) => spec.present);
  const index = present.findIndex((spec) => spec.id === id);
  if (index < 0) return null;
  const attached = new Set(attachedIds);
  for (let i = index + 1; i < present.length; i += 1) {
    const candidate = present[i]!.id;
    if (attached.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Patch controls in place. A newly created control is inserted once.
 * An ordinary tick does not remove, append, or otherwise move a control that is already present.
 */
export function syncStableControlHost(host: StableControlHost, specs: readonly StableControlSpec[]): void {
  let attached = host.ids().filter((id) => id.length > 0);
  const actions = stableControlActions(attached, specs);
  for (const action of actions) {
    if (action.op === "remove") {
      host.remove(action.id);
      attached = attached.filter((id) => id !== action.id);
      continue;
    }
    if (action.op === "create") {
      host.create(action.spec);
      const beforeId = nextAttachedSibling(specs, action.spec.id, attached);
      host.placeNew(action.spec.id, beforeId);
      const at = beforeId === null ? attached.length : attached.indexOf(beforeId);
      attached.splice(at < 0 ? attached.length : at, 0, action.spec.id);
      continue;
    }
    host.update(action.spec.id, action.spec);
  }
}
