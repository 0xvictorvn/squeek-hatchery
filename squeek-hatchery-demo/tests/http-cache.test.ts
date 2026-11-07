import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Reading } from "../src/rules.ts";
import { measurementDayKey } from "../src/rules.ts";
import { EXPERIMENTAL_POLICY_V1 } from "../src/game-policy.ts";
import { classifyStaticCache } from "../src/static-cache.ts";
import { createHatcheryHttpServer, tryServeStaticFile } from "../src/server.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";

test("static cache classes keep hashed dist assets, stable files, documents, and dev paths apart", () => {
  const rows: Array<{
    rootKind: "dist" | "public" | "lab" | "project";
    publicPath: string;
    method?: string;
    spaDocument?: boolean;
    cacheControl: string;
    conditional: boolean;
  }> = [
    { rootKind: "dist", publicPath: "/assets/app-abcdef12.js", cacheControl: IMMUTABLE, conditional: true },
    { rootKind: "dist", publicPath: "/assets/nested/app-abcdef12.css", cacheControl: IMMUTABLE, conditional: true },
    { rootKind: "dist", publicPath: "/assets/app-abcdef12.js.map", cacheControl: IMMUTABLE, conditional: true },
    { rootKind: "dist", publicPath: "/assets/app-abcdef12.js", method: "HEAD", cacheControl: IMMUTABLE, conditional: true },
    { rootKind: "dist", publicPath: "/assets/app-abcdef12.js", method: "POST", cacheControl: "no-store", conditional: false },
    { rootKind: "dist", publicPath: "/assets/short-abcdefg.js", cacheControl: "no-store", conditional: false },
    { rootKind: "dist", publicPath: "/assets/plain.js", cacheControl: "no-store", conditional: false },
    { rootKind: "project", publicPath: "/assets/app-abcdef12.js", cacheControl: "no-store", conditional: false },
    { rootKind: "public", publicPath: "/assets/app-abcdef12.js", cacheControl: "no-store", conditional: false },
    { rootKind: "dist", publicPath: "/index.html", cacheControl: "no-cache", conditional: true },
    { rootKind: "project", publicPath: "/play", spaDocument: true, cacheControl: "no-cache", conditional: true },
    { rootKind: "public", publicPath: "/art/egg-pulse-v2.png", cacheControl: REVALIDATE, conditional: true },
    { rootKind: "lab", publicPath: "/lab-assets/families-v2.png", cacheControl: REVALIDATE, conditional: true },
    { rootKind: "dist", publicPath: "/lab-assets/copied-atlas.png", cacheControl: REVALIDATE, conditional: true },
    { rootKind: "public", publicPath: "/favicon.ico", cacheControl: REVALIDATE, conditional: true },
    { rootKind: "public", publicPath: "/config.json", cacheControl: REVALIDATE, conditional: true },
    { rootKind: "project", publicPath: "/art/only-project.png", cacheControl: "no-store", conditional: false },
    { rootKind: "project", publicPath: "/config.json", cacheControl: "no-store", conditional: false },
    { rootKind: "dist", publicPath: "/notes.txt", cacheControl: "no-store", conditional: false },
    { rootKind: "project", publicPath: "/@vite/client", cacheControl: "no-store", conditional: false },
    { rootKind: "project", publicPath: "/src/main.ts", cacheControl: "no-store", conditional: false },
  ];

  for (const row of rows) {
    const actual = classifyStaticCache({
      rootKind: row.rootKind,
      publicPath: row.publicPath,
      method: row.method ?? "GET",
      spaDocument: row.spaDocument,
    });
    assert.equal(actual.cacheControl, row.cacheControl, `${row.method ?? "GET"} ${row.rootKind} ${row.publicPath}`);
    assert.equal(actual.conditional, row.conditional, `${row.method ?? "GET"} ${row.rootKind} ${row.publicPath}`);
  }
});

function strongEtag(bytes: Buffer): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

function requestOnce(
  origin: string,
  rawPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: rawPath,
        method: init.method ?? "GET",
        headers: { connection: "close", ...init.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error(`timed out ${init.method ?? "GET"} ${rawPath}`)));
    req.on("error", reject);
    if (init.body) req.end(init.body);
    else req.end();
  });
}

function readingAt(nowMs: number, distanceMm: number, work: bigint): Reading {
  return {
    coreStatus: "ACTIVE",
    rpm: 65,
    meters: distanceMm / 1000,
    distanceMm,
    work,
    counterEpoch: "cache-fixture-epoch",
    installationId: "cache-fixture-wheel",
    observedAt: nowMs,
    received: nowMs,
    staleAfterSeconds: 60,
    utcDate: measurementDayKey(nowMs),
  };
}

class MemoryResponse {
  statusCode = 0;
  headersSent = false;
  body: Buffer = Buffer.alloc(0);
  private headerMap = new Map<string, string>();
  setHeader(name: string, value: number | string | readonly string[]): void {
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    this.headerMap.set(name.toLowerCase(), text);
  }
  header(name: string): string | undefined {
    return this.headerMap.get(name.toLowerCase());
  }
  end(chunk?: string | Buffer): void {
    this.headersSent = true;
    if (chunk === undefined) this.body = Buffer.alloc(0);
    else this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

test("HTTP static cache validates hashed, stable, and API responses without caching errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "squeek-http-cache-"));
  let opened: ReturnType<typeof createHatcheryHttpServer> | undefined;
  try {
  const dist = path.join(root, "dist");
  const publicDir = path.join(root, "public");
  const lab = path.join(root, "lab");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dist, "lab-assets"), { recursive: true });
  fs.mkdirSync(path.join(publicDir, "art"), { recursive: true });
  fs.mkdirSync(path.join(project, "assets"), { recursive: true });
  fs.mkdirSync(path.join(project, "art"), { recursive: true });
  fs.mkdirSync(lab, { recursive: true });

  const hashedJs = Buffer.from("export const hashed = 1;\n");
  const hashedCss = Buffer.from(".lamp{color:#fff}\n");
  const shortJs = Buffer.from("short\n");
  const plainJs = Buffer.from("plain\n");
  const swapOriginal = Buffer.from("0123456789abcdef");
  const swapNext = Buffer.from("fedcba9876543210");
  const editOriginal = Buffer.from("version-a");
  const editNext = Buffer.from("version-aa");
  const artBytes = Buffer.from("stable-art-bytes");
  const atlasBytes = Buffer.from("atlas-bytes");
  const copiedAtlas = Buffer.from("copied-atlas");
  const favicon = Buffer.from("icon");
  const config = Buffer.from('{"build":"fixture"}');
  const indexHtml = Buffer.from("<!doctype html><title>fixture</title>");
  const fallbackJs = Buffer.from("fallback-hashed");
  const projectArt = Buffer.from("project-art");
  const notes = Buffer.from("notes");
  const secret = Buffer.from("TOP-SECRET-MARKER");
  const swapStamp = new Date("2026-01-15T00:00:00.000Z");
  const artStamp = new Date("2026-02-02T00:00:00.000Z");

  fs.writeFileSync(path.join(dist, "assets", "app-abcdef12.js"), hashedJs);
  fs.writeFileSync(path.join(dist, "assets", "app-abcdef12.css"), hashedCss);
  fs.writeFileSync(path.join(dist, "assets", "short-abcdefg.js"), shortJs);
  fs.writeFileSync(path.join(dist, "assets", "plain.js"), plainJs);
  fs.writeFileSync(path.join(dist, "assets", "swap-abcdef12.js"), swapOriginal);
  fs.utimesSync(path.join(dist, "assets", "swap-abcdef12.js"), swapStamp, swapStamp);
  fs.writeFileSync(path.join(dist, "assets", "edit-abcdef12.js"), editOriginal);
  fs.writeFileSync(path.join(dist, "index.html"), indexHtml);
  fs.writeFileSync(path.join(dist, "notes.txt"), notes);
  fs.writeFileSync(path.join(dist, "lab-assets", "copied-atlas.png"), copiedAtlas);
  fs.writeFileSync(path.join(publicDir, "art", "egg-pulse-v2.png"), artBytes);
  fs.utimesSync(path.join(publicDir, "art", "egg-pulse-v2.png"), artStamp, artStamp);
  fs.writeFileSync(path.join(publicDir, "favicon.ico"), favicon);
  fs.writeFileSync(path.join(publicDir, "config.json"), config);
  fs.writeFileSync(path.join(lab, "families-v2.png"), atlasBytes);
  fs.writeFileSync(path.join(project, "assets", "fallback-abcdef12.js"), fallbackJs);
  fs.writeFileSync(path.join(project, "art", "only-project.png"), projectArt);
  fs.writeFileSync(path.join(root, "secret.txt"), secret);

  const nowMs = Date.parse("2026-11-07T13:00:00.000Z");
  const dayRolloverMs = Date.parse("2026-11-07T12:00:05.000Z");
  opened = createHatcheryHttpServer(
    {
      dbPath: ":memory:",
      policy: EXPERIMENTAL_POLICY_V1,
      autoStartProducer: false,
      hardwareTimeoutMs: 1000,
      now: () => nowMs,
      hardwareProvider: async () => ({ reading: readingAt(nowMs, 300_000, 400n), source: "live" }),
    },
    { dist, publicDir, lab, project },
  );
  const { backend, server } = opened;
  backend.ingestHardwareReading(readingAt(dayRolloverMs, 0, 0n), "live", dayRolloverMs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("cache test server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;

  const send = (rawPath: string, init?: { method?: string; headers?: Record<string, string>; body?: Buffer }) =>
    requestOnce(origin, rawPath, init);

    const hashed = await send("/assets/app-abcdef12.js");
    assert.equal(hashed.status, 200);
    assert.ok(hashed.body.equals(hashedJs));
    assert.equal(header(hashed.headers, "cache-control"), IMMUTABLE);
    assert.equal(header(hashed.headers, "etag"), strongEtag(hashedJs));
    assert.equal(header(hashed.headers, "x-content-type-options"), "nosniff");
    assert.match(header(hashed.headers, "content-type") ?? "", /javascript/);
    assert.equal(header(hashed.headers, "etag")?.startsWith("W/"), false);
    const etag = header(hashed.headers, "etag") ?? "";

    const exact = await send("/assets/app-abcdef12.js", { headers: { "if-none-match": etag } });
    assert.equal(exact.status, 304);
    assert.equal(exact.body.length, 0);
    assert.equal(header(exact.headers, "content-length"), undefined);
    assert.equal(header(exact.headers, "etag"), etag);
    assert.equal(header(exact.headers, "cache-control"), IMMUTABLE);

    const weak = await send("/assets/app-abcdef12.js", { headers: { "if-none-match": `W/${etag}` } });
    assert.equal(weak.status, 304);
    assert.equal(weak.body.length, 0);

    const list = await send("/assets/app-abcdef12.js", {
      headers: { "if-none-match": `"not-the-etag", ${etag}` },
    });
    assert.equal(list.status, 304);
    assert.equal(list.body.length, 0);

    const star = await send("/assets/app-abcdef12.js", { headers: { "if-none-match": "*" } });
    assert.equal(star.status, 304);
    assert.equal(star.body.length, 0);

    const quotedStar = await send("/assets/app-abcdef12.js", { headers: { "if-none-match": '"*"' } });
    assert.equal(quotedStar.status, 200);
    assert.ok(quotedStar.body.equals(hashedJs));
    assert.equal(header(quotedStar.headers, "etag"), etag);

    const precedence = await send("/assets/app-abcdef12.js", {
      headers: {
        "if-none-match": '"not-the-etag"',
        "if-modified-since": "Tue, 01 Jan 2036 00:00:00 GMT",
      },
    });
    assert.equal(precedence.status, 200);
    assert.ok(precedence.body.equals(hashedJs));

    const head = await send("/assets/app-abcdef12.js", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(header(head.headers, "content-length")), hashedJs.length);
    assert.equal(header(head.headers, "etag"), etag);

    const headMatch = await send("/assets/app-abcdef12.js", {
      method: "HEAD",
      headers: { "if-none-match": etag },
    });
    assert.equal(headMatch.status, 304);
    assert.equal(headMatch.body.length, 0);
    assert.equal(header(headMatch.headers, "content-length"), undefined);

    const nested = await send("/result/assets/app-abcdef12.js");
    assert.equal(nested.status, 200);
    assert.equal(header(nested.headers, "cache-control"), IMMUTABLE);
    assert.equal(header(nested.headers, "etag"), etag);
    const nestedDocs = await send("/leaderboard/assets/app-abcdef12.js");
    assert.equal(header(nestedDocs.headers, "etag"), etag);

    const css = await send("/assets/app-abcdef12.css");
    assert.equal(css.status, 200);
    assert.equal(header(css.headers, "cache-control"), IMMUTABLE);
    assert.match(header(css.headers, "content-type") ?? "", /text\/css/);
    assert.equal(header(css.headers, "etag"), strongEtag(hashedCss));

    const short = await send("/assets/short-abcdefg.js", { headers: { "if-none-match": "*" } });
    assert.equal(short.status, 200);
    assert.equal(header(short.headers, "cache-control"), "no-store");
    assert.equal(header(short.headers, "etag"), undefined);
    assert.ok(short.body.equals(shortJs));

    const plain = await send("/assets/plain.js", { headers: { "if-none-match": "*" } });
    assert.equal(plain.status, 200);
    assert.equal(header(plain.headers, "cache-control"), "no-store");
    assert.ok(plain.body.equals(plainJs));

    const fallback = await send("/assets/fallback-abcdef12.js", { headers: { "if-none-match": "*" } });
    assert.equal(fallback.status, 200);
    assert.equal(header(fallback.headers, "cache-control"), "no-store");
    assert.ok(fallback.body.equals(fallbackJs));

    const projectOnly = await send("/art/only-project.png", { headers: { "if-none-match": "*" } });
    assert.equal(projectOnly.status, 200);
    assert.equal(header(projectOnly.headers, "cache-control"), "no-store");
    assert.ok(projectOnly.body.equals(projectArt));

    const note = await send("/notes.txt", { headers: { "if-none-match": "*" } });
    assert.equal(note.status, 200);
    assert.equal(header(note.headers, "cache-control"), "no-store");
    assert.equal(header(note.headers, "etag"), undefined);
    assert.ok(note.body.equals(notes));

    const posted = await send("/assets/app-abcdef12.js", {
      method: "POST",
      headers: { "if-none-match": "*" },
    });
    assert.equal(posted.status, 200);
    assert.equal(header(posted.headers, "cache-control"), "no-store");
    assert.equal(header(posted.headers, "etag"), undefined);
    assert.ok(posted.body.equals(hashedJs));

    const deleted = await send("/assets/app-abcdef12.js", {
      method: "DELETE",
      headers: { "if-none-match": "*" },
    });
    assert.equal(deleted.status, 200);
    assert.equal(header(deleted.headers, "cache-control"), "no-store");
    assert.ok(deleted.body.equals(hashedJs));

    const art = await send("/art/egg-pulse-v2.png");
    assert.equal(art.status, 200);
    assert.ok(art.body.equals(artBytes));
    assert.equal(header(art.headers, "cache-control"), REVALIDATE);
    assert.equal(header(art.headers, "cache-control")?.includes("immutable"), false);
    assert.equal(header(art.headers, "etag"), strongEtag(artBytes));
    assert.match(header(art.headers, "content-type") ?? "", /image\/png/);
    const artEtag = header(art.headers, "etag") ?? "";
    const artModified = header(art.headers, "last-modified") ?? "";
    assert.equal(Math.floor(Date.parse(artModified) / 1000), Math.floor(artStamp.getTime() / 1000));

    const artFresh = await send("/art/egg-pulse-v2.png", { headers: { "if-modified-since": artModified } });
    assert.equal(artFresh.status, 304);
    assert.equal(artFresh.body.length, 0);

    const artAncient = await send("/art/egg-pulse-v2.png", {
      headers: { "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
    });
    assert.equal(artAncient.status, 200);
    assert.ok(artAncient.body.equals(artBytes));

    const artMatchWins = await send("/art/egg-pulse-v2.png", {
      headers: { "if-none-match": artEtag, "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
    });
    assert.equal(artMatchWins.status, 304);
    assert.equal(artMatchWins.body.length, 0);

    const artMissWins = await send("/art/egg-pulse-v2.png", {
      headers: { "if-none-match": '"not-the-etag"', "if-modified-since": artModified },
    });
    assert.equal(artMissWins.status, 200);
    assert.ok(artMissWins.body.equals(artBytes));

    const artGarbage = await send("/art/egg-pulse-v2.png", { headers: { "if-modified-since": "not-a-date" } });
    assert.equal(artGarbage.status, 200);
    assert.ok(artGarbage.body.equals(artBytes));

    const atlas = await send("/lab-assets/families-v2.png?v=5");
    assert.equal(atlas.status, 200);
    assert.equal(header(atlas.headers, "cache-control"), REVALIDATE);
    assert.equal(header(atlas.headers, "etag"), strongEtag(atlasBytes));
    const atlasAgain = await send("/lab-assets/families-v2.png?v=5", {
      headers: { "if-none-match": header(atlas.headers, "etag") ?? "" },
    });
    assert.equal(atlasAgain.status, 304);
    assert.equal(atlasAgain.body.length, 0);
    const nestedAtlas = await send("/docs/lab-assets/families-v2.png");
    assert.equal(header(nestedAtlas.headers, "cache-control"), REVALIDATE);
    assert.equal(header(nestedAtlas.headers, "etag"), strongEtag(atlasBytes));

    const copied = await send("/lab-assets/copied-atlas.png");
    assert.equal(copied.status, 200);
    assert.equal(header(copied.headers, "cache-control"), REVALIDATE);
    assert.ok(copied.body.equals(copiedAtlas));

    const icon = await send("/favicon.ico");
    assert.equal(icon.status, 200);
    assert.equal(header(icon.headers, "cache-control"), REVALIDATE);
    assert.match(header(icon.headers, "content-type") ?? "", /icon/);

    const runtimeConfig = await send("/config.json");
    assert.equal(runtimeConfig.status, 200);
    assert.equal(header(runtimeConfig.headers, "cache-control"), REVALIDATE);
    assert.match(header(runtimeConfig.headers, "content-type") ?? "", /json/);
    assert.ok(runtimeConfig.body.equals(config));

    const play = await send("/play");
    assert.equal(play.status, 200);
    assert.ok(play.body.equals(indexHtml));
    assert.equal(header(play.headers, "cache-control"), "no-cache");
    assert.equal(header(play.headers, "etag"), strongEtag(indexHtml));
    const playAgain = await send("/play", { headers: { "if-none-match": header(play.headers, "etag") ?? "" } });
    assert.equal(playAgain.status, 304);
    assert.equal(playAgain.body.length, 0);
    const docs = await send("/docs");
    assert.equal(header(docs.headers, "cache-control"), "no-cache");
    assert.ok(docs.body.equals(indexHtml));
    const resultAlias = await send("/result/example");
    assert.equal(header(resultAlias.headers, "cache-control"), "no-cache");
    assert.ok(resultAlias.body.equals(indexHtml));

    const viteClient = await send("/@vite/client");
    assert.equal(viteClient.status, 200);
    assert.equal(header(viteClient.headers, "cache-control"), "no-cache");
    assert.equal(header(viteClient.headers, "cache-control")?.includes("immutable"), false);
    assert.ok(viteClient.body.equals(indexHtml));

    const missingModule = await send("/node_modules/vite/dist/client.js", { headers: { "if-none-match": "*" } });
    assert.equal(missingModule.status, 404);
    assert.equal(header(missingModule.headers, "cache-control"), "no-store");
    assert.ok(missingModule.body.length > 0);

    const missingHead = await send("/art/missing-never.png", { method: "HEAD", headers: { "if-none-match": "*" } });
    assert.equal(missingHead.status, 404);
    assert.equal(missingHead.body.length, 0);
    assert.equal(header(missingHead.headers, "cache-control"), "no-store");

    const lateMiss = await send("/art/late.png");
    assert.equal(lateMiss.status, 404);
    assert.equal(header(lateMiss.headers, "cache-control"), "no-store");
    const lateMissAgain = await send("/art/late.png", { headers: { "if-none-match": "*" } });
    assert.equal(lateMissAgain.status, 404);
    const lateBytes = Buffer.from("arrived-later");
    fs.writeFileSync(path.join(publicDir, "art", "late.png"), lateBytes);
    const lateHit = await send("/art/late.png");
    assert.equal(lateHit.status, 200);
    assert.equal(header(lateHit.headers, "cache-control"), REVALIDATE);
    assert.ok(lateHit.body.equals(lateBytes));

    const traversal = await send("/assets/%2e%2e%2f%2e%2e%2fsecret.txt", { headers: { "if-none-match": "*" } });
    assert.notEqual(traversal.status, 200);
    assert.equal(traversal.body.includes(secret), false);
    assert.equal(header(traversal.headers, "cache-control"), "no-store");
    assert.ok(traversal.status === 403 || traversal.status === 404);

    const guarded = new MemoryResponse();
    const guardedServed = tryServeStaticFile(
      dist,
      "../secret.txt",
      guarded as unknown as ServerResponse,
      undefined,
      { rootKind: "dist", publicPath: "/../secret.txt" },
    );
    assert.equal(guardedServed, true);
    assert.equal(guarded.statusCode, 403);
    assert.equal(guarded.header("cache-control"), "no-store");
    assert.equal(guarded.header("x-content-type-options"), "nosniff");
    assert.equal(guarded.body.toString("utf8"), "Forbidden");

    const swapPath = path.join(dist, "assets", "swap-abcdef12.js");
    const swapBefore = await send("/assets/swap-abcdef12.js");
    assert.equal(swapBefore.status, 200);
    assert.ok(swapBefore.body.equals(swapOriginal));
    const swapEtag = header(swapBefore.headers, "etag") ?? "";
    const swapModified = header(swapBefore.headers, "last-modified") ?? "";
    assert.equal(swapEtag, strongEtag(swapOriginal));
    fs.writeFileSync(swapPath, swapNext);
    fs.utimesSync(swapPath, swapStamp, swapStamp);
    assert.equal(swapOriginal.length, swapNext.length);
    assert.equal(Math.floor(fs.statSync(swapPath).mtimeMs / 1000), Math.floor(swapStamp.getTime() / 1000));
    const swapChanged = await send("/assets/swap-abcdef12.js", {
      headers: { "if-none-match": swapEtag, "if-modified-since": swapModified },
    });
    assert.equal(swapChanged.status, 200);
    assert.ok(swapChanged.body.equals(swapNext));
    const swapNewEtag = header(swapChanged.headers, "etag") ?? "";
    assert.notEqual(swapNewEtag, swapEtag);
    assert.equal(swapNewEtag, strongEtag(swapNext));
    const swapFresh = await send("/assets/swap-abcdef12.js", { headers: { "if-none-match": swapNewEtag } });
    assert.equal(swapFresh.status, 304);
    assert.equal(swapFresh.body.length, 0);

    const editBefore = await send("/assets/edit-abcdef12.js");
    const editEtag = header(editBefore.headers, "etag") ?? "";
    assert.equal(editEtag, strongEtag(editOriginal));
    fs.writeFileSync(path.join(dist, "assets", "edit-abcdef12.js"), editNext);
    const editAfter = await send("/assets/edit-abcdef12.js", { headers: { "if-none-match": editEtag } });
    assert.equal(editAfter.status, 200);
    assert.ok(editAfter.body.equals(editNext));
    assert.equal(header(editAfter.headers, "etag"), strongEtag(editNext));
    assert.notEqual(editOriginal.length, editNext.length);

    const validators = {
      "if-none-match": "*",
      "if-modified-since": "Tue, 01 Jan 2036 00:00:00 GMT",
    };
    const apiPaths = [
      "/api/auth/session",
      "/api/hardware/status",
      "/api/leaderboard",
      "/api/policy",
      "/api/results/missing-result",
      "/api/not-a-real-endpoint",
    ];
    for (const apiPath of apiPaths) {
      const api = await send(apiPath, { headers: validators });
      assert.notEqual(api.status, 304, apiPath);
      assert.equal(header(api.headers, "cache-control"), "no-store", apiPath);
      assert.equal(header(api.headers, "x-content-type-options"), "nosniff", apiPath);
      assert.ok(api.body.length > 0, apiPath);
    }
    assert.equal((await send("/api/hardware/status", { headers: validators })).status, 200);
    assert.equal((await send("/api/leaderboard", { headers: validators })).status, 200);
    assert.equal((await send("/api/policy", { headers: validators })).status, 200);
    assert.equal((await send("/api/auth/session", { headers: validators })).status, 200);
    assert.equal((await send("/api/results/missing-result", { headers: validators })).status, 404);
    assert.equal((await send("/api/not-a-real-endpoint", { headers: validators })).status, 404);

    const challengeBody = Buffer.from(
      JSON.stringify({ walletAddress: "0x0000000000000000000000000000000000000001", chainId: 11155111 }),
    );
    const challenge = await send("/api/auth/challenge", {
      method: "POST",
      headers: {
        ...validators,
        origin,
        "content-type": "application/json",
        "content-length": String(challengeBody.length),
      },
      body: challengeBody,
    });
    assert.equal(challenge.status, 200);
    assert.notEqual(challenge.status, 304);
    assert.equal(header(challenge.headers, "cache-control"), "no-store");
    const challengeJson = JSON.parse(challenge.body.toString("utf8")) as { challengeId?: unknown };
    assert.equal(typeof challengeJson.challengeId, "string");
  } finally {
    const running = opened;
    try {
      if (running && running.server.listening) {
        await new Promise<void>((resolve, reject) => {
          running.server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      running?.backend.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
