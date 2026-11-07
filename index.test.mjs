import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const store = new Map();
const settings = new Map();

globalThis.host = {
  platform: "darwin",
  arch: "arm64",
  dir: "",
  dataDir: "",
  storage: {
    get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    set(key, value) {
      store.set(key, value);
    },
    remove(key) {
      store.delete(key);
    },
  },
  setting(key) {
    return settings.get(key) || "";
  },
  t(text) {
    return text;
  },
  language() {
    return "en";
  },
  openURL() {},
};

const plugin = await import("./index.js");

const empty = { code: 0, data: { list: [], total: 0 } };
let handler = async () => json(empty);

globalThis.fetch = async (url, init = {}) => handler(String(url), init);

function json(data, status = 200) {
  return {
    status,
    async text() {
      return JSON.stringify(data);
    },
  };
}

function reset() {
  store.clear();
  settings.clear();
  plugin.__reset();
  handler = async () => json(empty);
}

function signedIn() {
  store.set("server", "http://nas.local:5666");
  store.set("token", "tok123");
  store.set("cookie", "music-token=tok123");
  store.set("accessHeader", "");
  store.set("accessSource", "");
  store.set("user", { id: "u1", name: "Listener" });
}

function route(map) {
  handler = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^.*\/music\/api\/v1/, "");
    const fn = map[path];
    return fn ? fn(parsed, init) : json(empty);
  };
}

function track(overrides = {}) {
  return {
    guid: "t1",
    title: "Song",
    duration: 123000,
    artists: [{ guid: "a1", name: "Artist" }],
    album: { guid: "al1", name: "Album", coverId: "cover1" },
    audioSpec: { format: "flac" },
    ...overrides,
  };
}

test("SHA-256 matches the platform's", () => {
  for (const text of ["", "abc", "密码123", "a".repeat(1000)]) {
    assert.equal(
      plugin.__test.sha256Hex(text),
      createHash("sha256").update(text).digest("hex"),
    );
  }
});

test("server URLs are normalized", () => {
  assert.equal(
    plugin.__test.normalizeServer("192.168.1.10:5666"),
    "http://192.168.1.10:5666",
  );
  assert.equal(
    plugin.__test.normalizeServer("https://nas.example.com/music/api/v1/"),
    "https://nas.example.com",
  );
});

test("signing in hashes the password and keeps the token", async () => {
  reset();
  settings.set("server", "192.168.1.10:5666");
  settings.set("username", "alice");
  settings.set("password", "secret");

  let captured;
  handler = async (url, init) => {
    captured = { url: String(url), init };
    return json({
      code: 0,
      data: { userToken: "tok123", user: { guid: "u1", name: "Listener" } },
    });
  };

  const account = await plugin.signIn();
  assert.equal(
    captured.url,
    "http://192.168.1.10:5666/music/api/v1/user/password-login",
  );

  const body = JSON.parse(captured.init.body);
  assert.equal(body.username, "alice");
  assert.equal(
    body.password,
    createHash("sha256").update("secret").digest("hex"),
  );
  assert.match(body.deviceId, /^[0-9a-f]{32}$/);

  assert.deepEqual(account, { id: "u1", name: "Listener" });
  assert.deepEqual(plugin.account(), account);
  assert.equal(store.get("cookie"), "music-token=tok123");
});

test("an access code goes base64 in the header and in storage", async () => {
  reset();
  settings.set("server", "http://nas.local:5666");
  settings.set("username", "alice");
  settings.set("password", "secret");
  settings.set("accessCode", "1234");

  let headers;
  handler = async (url, init) => {
    headers = init.headers;
    return json({ code: 0, data: { userToken: "tok123", user: {} } });
  };

  await plugin.signIn();
  const encoded = Buffer.from("1234").toString("base64");
  assert.equal(headers["x-access-code"], encoded);
  assert.equal(store.get("accessHeader"), encoded);
  assert.equal(store.get("accessSource"), "app");
});

test("signing in without settings asks for setup", async () => {
  reset();
  await assert.rejects(
    () => plugin.signIn(),
    (error) => error.code === "setup",
  );
});

test("home maps tracks, albums and covers", async () => {
  reset();
  signedIn();
  route({
    "/track/list": () =>
      json({ code: 0, data: { list: [track()], total: 1 } }),
  });

  const home = await plugin.home();
  const section = home.sections.find((item) => item.title === "Recently added");
  assert.equal(section.morePage, "songs");
  assert.equal(section.tracks[0].id, "t1");
  assert.equal(section.tracks[0].duration, 123000);
  assert.equal(section.tracks[0].artists[0].name, "Artist");
  assert.equal(
    section.tracks[0].album.imageUrl,
    "http://nas.local:5666/music/api/v1/static/cover?coverId=cover1&size={size}",
  );
});

test("a listed format is used to stream without another request", async () => {
  reset();
  signedIn();
  route({
    "/track/list": () =>
      json({ code: 0, data: { list: [track()], total: 1 } }),
  });
  await plugin.home();

  const stream = await plugin.stream({ id: "t1" });
  assert.equal(stream.type, "flac");
  assert.equal(
    stream.url,
    "http://nas.local:5666/music/api/v1/track/stream?guid=t1",
  );
  assert.equal(stream.headers.cookie, "music-token=tok123");
});

test("search turns an offset into the service's page", async () => {
  reset();
  signedIn();
  let query;
  route({
    "/search/track": (parsed) => {
      query = parsed.searchParams;
      return json({
        code: 0,
        data: {
          list: Array.from({ length: 30 }, (_, index) => ({
            guid: "t" + index,
            title: "T" + index,
            artists: [],
            album: {},
          })),
          total: 65,
        },
      });
    },
  });

  const second = await plugin.search({ query: "x", kind: "tracks", offset: 30 });
  assert.equal(query.get("page"), "2");
  assert.equal(query.get("size"), "30");
  assert.equal(second.tracks.length, 30);
  assert.equal(second.more, true);

  const third = await plugin.search({ query: "x", kind: "tracks", offset: 60 });
  assert.equal(query.get("page"), "3");
  assert.equal(third.more, false);
});

test("liking posts the track's GUID", async () => {
  reset();
  signedIn();
  let body;
  route({
    "/favorite-track/create": (parsed, init) => {
      body = JSON.parse(init.body);
      return json({ code: 0, data: null });
    },
  });

  await plugin.like({ id: "t1", on: true });
  assert.deepEqual(body, { trackGUID: "t1" });
});

test("lyrics take the preferred version", async () => {
  reset();
  signedIn();
  route({
    "/lyric/list": () =>
      json({
        code: 0,
        data: {
          preferred: "l2",
          list: [
            { guid: "l1", content: "[00:01]one" },
            { guid: "l2", content: "[00:01]two" },
          ],
        },
      }),
  });

  assert.deepEqual(await plugin.lyrics({ id: "t1" }), { lrc: "[00:01]two" });
});

test("an album page brings its tracks and artists", async () => {
  reset();
  signedIn();
  route({
    "/album/detail": () =>
      json({
        code: 0,
        data: { guid: "al1", name: "Album", coverId: "c1", releaseDate: 2024 },
      }),
    "/track/album-detail/list": () =>
      json({ code: 0, data: { list: [track()], total: 1 } }),
  });

  const page = await plugin.album({ id: "al1" });
  assert.equal(page.album.name, "Album");
  assert.equal(page.album.released, "2024");
  assert.equal(page.album.artists[0].name, "Artist");
  assert.equal(page.tracks.length, 1);
});

test("a format the app can't play is unavailable", async () => {
  reset();
  signedIn();
  route({
    "/track/metadata": () =>
      json({ code: 0, data: { track: { audioSpec: { format: "dsf" } } } }),
  });

  await assert.rejects(
    () => plugin.stream({ id: "t1" }),
    (error) => error.code === "unavailable" && /dsf/.test(error.message),
  );
});

test("a 401 asks the listener to sign in again", async () => {
  reset();
  signedIn();
  handler = async () => json({ code: 401, msg: "INVALID TOKEN" });
  await assert.rejects(
    () => plugin.playlists(),
    (error) => error.code === "signIn",
  );
});

test("plugin.json sends the cookie with covers and audio", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("./plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.id, "feiniu");
  assert.equal(manifest.playback, "stream");
  assert.deepEqual(manifest.permissions.network, ["*"]);
  assert.deepEqual(manifest.requestHeaders[0].hosts, ["{setting:server}"]);
  assert.deepEqual(manifest.requestHeaders[0].kinds, ["image", "audio"]);
  assert.equal(
    manifest.requestHeaders[0].headers.cookie,
    "{storage:cookie}",
  );
});
