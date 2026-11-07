// Feiniu Music (fnOS Music) for MyGo Music.
//
// MyGo Music supplies host and fetch; this module has no Node dependencies.
// The fnOS music service answers under /music/api/v1 with a JSON envelope of
// {code, msg, data}, and authenticates with a `music-token` cookie. Most of
// the endpoints below were checked against the community clients
// kuilei0926/FeiNiuMusic and qianlipp/fn-music-bridge.

const API = "/music/api/v1";
const SEARCH_PAGE = 30;
const LIST_LIMIT = 300;
const FAVORITES_TTL = 60 * 1000;

// The app supports these container/codec pairs; anything else is transcoded.
const AUDIO_TYPES = {
  mp3: "mp3",
  flac: "flac",
  ogg: "ogg",
  oga: "ogg",
  vorbis: "ogg",
  wav: "wav",
  m4a: "m4a",
  mp4: "m4a",
  alac: "m4a",
  aac: "aac",
};

let cachedSession = null;
let favoritesCache = null; // { at, ids: Set }
const formats = new Map(); // track GUID -> audio format, from what was listed

function t(text) {
  return host.t(text);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function str(value) {
  return value === undefined || value === null ? "" : String(value);
}

// Storage and settings are only read inside exported actions: MyGo loads the
// module while holding its storage lock.
function read(key) {
  try {
    return host.storage.get(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    host.storage.set(key, value);
  } catch {
    // A failed write only costs a sign-in later.
  }
}

function erase(key) {
  try {
    host.storage.remove(key);
  } catch {
    // Nothing to do.
  }
}

function normalizeServer(value) {
  let server = str(value).trim();
  if (!server) return "";
  if (!/^https?:\/\//i.test(server)) server = "http://" + server;
  server = server.replace(/\/+$/, "");
  server = server.replace(/\/music\/api\/v1$/i, "");
  return server.replace(/\/+$/, "");
}

function session() {
  if (cachedSession) return cachedSession;
  cachedSession = {
    server: normalizeServer(read("server")),
    token: str(read("token")),
    cookie: str(read("cookie")),
    accessHeader: str(read("accessHeader")),
    accessSource: str(read("accessSource")),
    user: read("user") || null,
  };
  return cachedSession;
}

function serverRoot() {
  const s = session();
  return s.server || normalizeServer(host.setting("server"));
}

function authHeaders() {
  const s = session();
  const headers = {};
  const cookie = s.cookie || (s.token ? "music-token=" + s.token : "");
  if (cookie) headers.cookie = cookie;
  if (s.accessHeader) {
    headers["x-access-code"] = s.accessHeader;
    headers["x-access-source"] = s.accessSource || "app";
  }
  return headers;
}

function queryString(values) {
  const parts = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }
  return parts.join("&");
}

function apiURL(path, query) {
  const params = queryString(query);
  return serverRoot() + API + path + (params ? "?" + params : "");
}

async function api(path, options = {}) {
  const s = session();
  if (!s.token) fail("signIn", t("Sign in to Feiniu Music first."));

  const init = {
    method: options.method || "GET",
    headers: { accept: "application/json", ...authHeaders() },
  };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(apiURL(path, options.query), init);
  } catch (error) {
    fail("unavailable", t("Could not reach Feiniu Music.") + " " + errorMessage(error));
  }

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      fail("unavailable", t("Feiniu Music answered with something that isn't JSON.") + " (HTTP " + response.status + ")");
    }
  }

  if (response.status === 401) {
    fail("signIn", t("Your session has expired. Sign in again."));
  }

  const code = Number(payload.code);
  if (code !== 0) {
    const message = str(payload.msg);
    if (code === 401 || /invalid token/i.test(message)) {
      fail("signIn", t("Your session has expired. Sign in again."));
    }
    if (code === 120001) fail("signIn", t("Wrong username or password."));
    fail("unavailable", message || t("Feiniu Music returned an error.") + " " + code);
  }
  return payload.data;
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

async function maybe(promise) {
  try {
    return await promise;
  } catch (error) {
    // A missing session is the listener's to fix, not something to hide.
    if (error && (error.code === "signIn" || error.code === "setup")) throw error;
    return null;
  }
}

function pageOf(data) {
  const body = data || {};
  return {
    list: Array.isArray(body.list) ? body.list : [],
    total: Number(body.total) || 0,
  };
}

// A cover is fetched by the app itself, so plugin.json's requestHeaders send
// the cookie with it. {size} is filled in with the pixels it shows at.
function coverURL(coverId) {
  const id = str(coverId);
  if (!id) return "";
  return serverRoot() + API + "/static/cover?coverId=" + encodeURIComponent(id) + "&size={size}";
}

function releaseText(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  if (number >= 1900 && number <= 3000) return String(number);
  const milliseconds = number > 1e12 ? number : number > 1e9 ? number * 1000 : 0;
  if (!milliseconds) return "";
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function artistOf(artist) {
  const a = artist || {};
  return {
    id: str(a.guid),
    name: str(a.name) || t("Unknown artist"),
    imageUrl: coverURL(a.coverId),
  };
}

function albumOf(album) {
  const a = album || {};
  return {
    id: str(a.guid),
    name: str(a.name) || t("Unknown album"),
    imageUrl: coverURL(a.coverId),
    released: releaseText(a.releaseDate),
  };
}

function trackOf(track) {
  const item = track || {};
  const album = item.album || {};
  const coverId = str(item.coverId) || str(album.coverId);
  const format = str(item.audioSpec && item.audioSpec.format).toLowerCase();
  if (item.guid && format) formats.set(str(item.guid), format);

  return {
    id: str(item.guid),
    name: str(item.title) || t("Unknown track"),
    artists: (item.artists || []).map(artistOf),
    album: {
      id: str(album.guid),
      name: str(album.name) || t("Unknown album"),
      imageUrl: coverURL(coverId),
    },
    duration: Number(item.duration) || 0,
    unavailable: Boolean(
      item.isAudioFileDeleted || item.audioFileDeleted || String(item.accessStatus) === "3",
    ),
  };
}

function playlistOf(playlist) {
  const p = playlist || {};
  return {
    id: str(p.guid),
    name: str(p.name) || t("Untitled playlist"),
    imageUrl: coverURL(p.coverId),
    trackCount: Number(p.trackCount) || 0,
    mine: true,
  };
}

function uniqueArtists(tracks) {
  const seen = new Set();
  const artists = [];
  for (const track of tracks || []) {
    for (const artist of track.artists || []) {
      const id = str(artist.guid) || str(artist.name);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      artists.push(artistOf(artist));
    }
  }
  return artists;
}

function audioType(format) {
  return AUDIO_TYPES[str(format).toLowerCase()] || "";
}

function streamURL(guid) {
  return serverRoot() + API + "/track/stream?guid=" + encodeURIComponent(guid);
}

function randomHex32() {
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

function deviceID() {
  let id = str(read("deviceId"));
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    id = randomHex32();
    write("deviceId", id);
  }
  return id;
}

function base64(text) {
  const bytes = utf8Bytes(text);
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? alphabet[c & 63] : "=";
  }
  return out;
}

function utf8Bytes(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      i += 1;
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(bytes);
}

// SHA-256, because the service takes the password hashed and the host only
// offers MD5 and AES.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(text) {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(w[i - 15], 7) ^ rotateRight(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotateRight(w[i - 2], 17) ^ rotateRight(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function clearSession() {
  for (const key of ["token", "cookie", "accessHeader", "accessSource", "user", "roamId"]) {
    erase(key);
  }
  cachedSession = null;
  favoritesCache = null;
  formats.clear();
}

export function setSetting({ key }) {
  if (["server", "username", "password", "accessCode"].includes(str(key))) {
    clearSession();
  }
}

export async function signIn() {
  const server = normalizeServer(host.setting("server"));
  const username = str(host.setting("username")).trim();
  const password = str(host.setting("password"));
  const accessCode = str(host.setting("accessCode")).trim();

  if (!server) fail("setup", t("Set the Feiniu Music server URL in plugin settings."));
  if (!username || !password) {
    fail("setup", t("Set your Feiniu Music username and password in plugin settings."));
  }

  const headers = { accept: "application/json", "content-type": "application/json" };
  const accessHeader = accessCode ? base64(accessCode) : "";
  if (accessHeader) {
    headers["x-access-code"] = accessHeader;
    headers["x-access-source"] = "app";
  }

  let response;
  try {
    response = await fetch(server + API + "/user/password-login", {
      method: "POST",
      headers,
      body: JSON.stringify({
        username,
        password: sha256Hex(password),
        deviceId: deviceID(),
      }),
    });
  } catch (error) {
    fail("unavailable", t("Could not reach Feiniu Music.") + " " + errorMessage(error));
  }

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      fail("unavailable", t("Feiniu Music answered with something that isn't JSON.") + " (HTTP " + response.status + ")");
    }
  }

  const code = Number(payload.code);
  if (code !== 0) {
    const message = str(payload.msg);
    if (code === 120001) fail("signIn", t("Wrong username or password."));
    if (code === 401 || /invalid token/i.test(message)) fail("signIn", message || t("Sign-in failed."));
    fail("unavailable", message || t("Feiniu Music returned an error.") + " " + code);
  }

  const data = payload.data || {};
  const token = str(data.userToken);
  if (!token) fail("unavailable", t("Feiniu Music didn't answer with a token."));

  const user = data.user || {};
  const account = {
    id: str(user.guid) || username,
    name: str(user.name) || username,
  };
  const cookie = "music-token=" + token;

  cachedSession = {
    server,
    token,
    cookie,
    accessHeader,
    accessSource: accessHeader ? "app" : "",
    user: account,
  };
  write("server", server);
  write("token", token);
  write("cookie", cookie);
  write("accessHeader", accessHeader);
  write("accessSource", accessHeader ? "app" : "");
  write("user", account);
  favoritesCache = null;
  formats.clear();
  return account;
}

export function signOut() {
  clearSession();
}

export function account() {
  const s = session();
  if (!s.token) return null;
  return s.user || { id: "", name: str(host.setting("username")) || "Feiniu Music" };
}

async function trackPage(title, path, query, empty) {
  const data = pageOf(await api(path, { query }));
  return {
    title: t(title),
    sections: [{ tracks: data.list.map(trackOf), empty: t(empty || "Nothing here yet.") }],
  };
}

async function albumPage(title, path, query) {
  const data = pageOf(await api(path, { query }));
  return {
    title: t(title),
    sections: [{ albums: data.list.map(albumOf), empty: t("Nothing here yet.") }],
  };
}

async function artistPage(title, path, query) {
  const data = pageOf(await api(path, { query }));
  return {
    title: t(title),
    sections: [{ artists: data.list.map(artistOf), empty: t("Nothing here yet.") }],
  };
}

async function playlistPage(title, path, query) {
  const data = pageOf(await api(path, { query }));
  return {
    title: t(title),
    sections: [{ playlists: data.list.map(playlistOf), empty: t("Nothing here yet.") }],
  };
}

export async function home() {
  const [tracks, albums, playlists, favorites, history, artists] = await Promise.all([
    maybe(api("/track/list", { query: { page: 1, size: 12, sort: "createdAt,desc" } })),
    maybe(api("/album/list", { query: { page: 1, size: 12, sort: "newTrackAddedAt,desc" } })),
    maybe(api("/playlist/list", { query: { page: 1, size: 12 } })),
    maybe(api("/favorite-track/list", { query: { page: 1, size: 12, sort: "favoriteAt,desc" } })),
    maybe(api("/play-history/list", { query: { page: 1, size: 12 } })),
    maybe(api("/artist/list", { query: { page: 1, size: 12 } })),
  ]);

  const sections = [];
  const recentTracks = pageOf(tracks).list;
  if (recentTracks.length) {
    sections.push({
      title: t("Recently added"),
      tracks: recentTracks.map(trackOf),
      morePage: "songs",
    });
  }
  const played = pageOf(history).list;
  if (played.length) {
    sections.push({
      title: t("Recently played"),
      tracks: played.map(trackOf),
      morePage: "recent",
    });
  }
  const liked = pageOf(favorites).list;
  if (liked.length) {
    sections.push({
      title: t("Liked"),
      tracks: liked.map(trackOf),
      morePage: "favorites",
    });
  }
  const albumList = pageOf(albums).list;
  if (albumList.length) {
    sections.push({
      title: t("Albums"),
      albums: albumList.map(albumOf),
      morePage: "albums",
    });
  }
  const playlistList = pageOf(playlists).list;
  if (playlistList.length) {
    sections.push({
      title: t("Playlists"),
      playlists: playlistList.map(playlistOf),
      morePage: "playlists",
    });
  }
  const artistList = pageOf(artists).list;
  if (artistList.length) {
    sections.push({
      title: t("Artists"),
      artists: artistList.map(artistOf),
      morePage: "artists",
    });
  }

  return { title: t("Feiniu Music"), subtitle: serverRoot(), sections };
}

export async function browse({ page }) {
  const name = str(page);

  if (name === "songs") {
    return trackPage("All songs", "/track/list", {
      page: 1,
      size: LIST_LIMIT,
      sort: "createdAt,desc",
    });
  }
  if (name === "recent") {
    return trackPage("Recently played", "/play-history/list", { page: 1, size: 100 });
  }
  if (name === "favorites") {
    return trackPage("Liked", "/favorite-track/list", {
      page: 1,
      size: LIST_LIMIT,
      sort: "favoriteAt,desc",
    });
  }
  if (name === "albums") {
    return albumPage("Albums", "/album/list", {
      page: 1,
      size: LIST_LIMIT,
      sort: "newTrackAddedAt,desc",
    });
  }
  if (name === "artists") {
    return artistPage("Artists", "/artist/list", { page: 1, size: LIST_LIMIT });
  }
  if (name === "playlists") {
    return playlistPage("Playlists", "/playlist/list", { page: 1, size: -1 });
  }
  if (name === "genres") {
    const data = pageOf(await api("/genre/list", { query: { page: 1, size: 200 } }));
    return {
      title: t("Genres"),
      sections: [
        {
          links: data.list.map((genre) => ({
            title: str(genre.name) || t("Unknown genre"),
            subtitle: genre.trackCount ? String(genre.trackCount) + " " + t("songs") : "",
            page: "genre:" + str(genre.guid),
          })),
          empty: t("Nothing here yet."),
        },
      ],
    };
  }
  if (name.startsWith("genre:")) {
    const guid = name.slice("genre:".length);
    const data = pageOf(
      await api("/track/genre-detail/list", {
        query: { genreGUID: guid, page: 1, size: LIST_LIMIT, sort: "createdAt,desc" },
      }),
    );
    return {
      title: t("Genre"),
      sections: [{ tracks: data.list.map(trackOf), empty: t("Nothing here yet.") }],
    };
  }

  fail("unavailable", t("No such Feiniu Music page."));
}

export async function search({ query, kind, offset = 0 }) {
  const q = str(query).trim();
  const start = Math.max(0, Number(offset) || 0);
  if (!q) return { [kind]: [], more: false };

  const spec = {
    tracks: ["/search/track", "tracks", trackOf],
    albums: ["/search/album", "albums", albumOf],
    artists: ["/search/artist", "artists", artistOf],
    playlists: ["/search/playlist", "playlists", playlistOf],
  }[kind];
  if (!spec) return { [kind]: [], more: false };

  const page = Math.floor(start / SEARCH_PAGE) + 1;
  const skip = start % SEARCH_PAGE;
  const data = pageOf(
    await api(spec[0], { query: { q, page, size: SEARCH_PAGE } }),
  );
  const items = data.list.slice(skip).map(spec[2]);
  return {
    [spec[1]]: items,
    more: page * SEARCH_PAGE < data.total,
  };
}

export async function recent() {
  const data = pageOf(await api("/play-history/list", { query: { page: 1, size: 50 } }));
  return data.list.map(trackOf);
}

export async function played({ id }) {
  try {
    await api("/event/report", {
      method: "POST",
      body: {
        events: [
          {
            eventType: "track_play",
            occurredAt: Date.now(),
            payload: { trackGUID: str(id) },
          },
        ],
      },
    });
  } catch {
    // Reporting a play is a courtesy; it never blocks playback.
  }
}

export async function liked({ offset = 0 }) {
  const start = Math.max(0, Number(offset) || 0);
  const page = Math.floor(start / SEARCH_PAGE) + 1;
  const data = pageOf(
    await api("/favorite-track/list", {
      query: { page, size: SEARCH_PAGE, sort: "favoriteAt,desc" },
    }),
  );
  return {
    tracks: data.list.slice(start % SEARCH_PAGE).map(trackOf),
    more: page * SEARCH_PAGE < data.total,
  };
}

async function favoriteIDs() {
  const now = Date.now();
  if (favoritesCache && now - favoritesCache.at < FAVORITES_TTL) {
    return favoritesCache.ids;
  }
  const data = pageOf(await api("/favorite-track/list", { query: { page: 1, size: -1 } }));
  const ids = new Set(data.list.map((item) => str(item.guid)));
  favoritesCache = { at: now, ids };
  return ids;
}

export async function isLiked({ ids }) {
  const wanted = Array.isArray(ids) ? ids.map(str) : [];
  const likedIDs = await favoriteIDs();
  const answer = {};
  for (const id of wanted) answer[id] = likedIDs.has(id);
  return answer;
}

export async function like({ id, on }) {
  await api(on ? "/favorite-track/create" : "/favorite-track/delete", {
    method: "POST",
    body: { trackGUID: str(id) },
  });
  favoritesCache = null;
}

export async function album({ id }) {
  const guid = str(id);
  const [detail, tracks] = await Promise.all([
    maybe(api("/album/detail", { query: { guid } })),
    maybe(
      api("/track/album-detail/list", {
        query: { albumGUID: guid, page: 1, size: 500, sort: "discNo,asc" },
      }),
    ),
  ]);
  const list = pageOf(tracks).list;
  const raw = detail && (detail.album || detail);
  if (!raw && !list.length) fail("unavailable", t("Album not found."));

  const info = albumOf(
    raw && raw.guid
      ? raw
      : {
          guid,
          name: list[0] && list[0].album ? list[0].album.name : "",
          coverId: list[0] && list[0].album ? list[0].album.coverId : "",
        },
  );
  info.artists = uniqueArtists(list);
  return { album: info, tracks: list.map(trackOf) };
}

export async function artist({ id }) {
  const guid = str(id);
  const [detail, tracks, albums] = await Promise.all([
    maybe(api("/artist/detail", { query: { guid } })),
    maybe(
      api("/track/artist-detail/list", {
        query: { artistGUID: guid, page: 1, size: 300, sort: "createdAt,desc" },
      }),
    ),
    maybe(
      api("/album/artist-detail/list", {
        query: { artistGUID: guid, page: 1, size: 100 },
      }),
    ),
  ]);
  const list = pageOf(tracks).list;
  const raw = detail && (detail.artist || detail);
  if (!raw && !list.length) fail("unavailable", t("Artist not found."));

  const info = artistOf(
    raw && raw.guid
      ? raw
      : { guid, name: list[0] && list[0].artists && list[0].artists[0] ? list[0].artists[0].name : "" },
  );
  return {
    artist: info,
    tracks: list.map(trackOf),
    albums: pageOf(albums).list.map(albumOf),
  };
}

export async function playlists() {
  const data = pageOf(await api("/playlist/list", { query: { page: 1, size: -1 } }));
  return data.list.map(playlistOf);
}

export async function playlist({ id }) {
  const guid = str(id);
  const [detail, tracks] = await Promise.all([
    maybe(api("/playlist/detail", { query: { guid } })),
    maybe(
      api("/track/playlist-detail/list", {
        query: { playlistGUID: guid, page: 1, size: 1000 },
      }),
    ),
  ]);
  const list = pageOf(tracks).list;
  const raw = detail && (detail.playlist || detail);
  if (!raw && !list.length) fail("unavailable", t("Playlist not found."));

  const info = playlistOf(raw && raw.guid ? raw : { guid });
  info.tracks = list.map(trackOf);
  if (!info.trackCount) info.trackCount = info.tracks.length;
  return info;
}

export async function createPlaylist({ name }) {
  const title = str(name).trim() || t("Untitled playlist");
  const raw = await api("/playlist/create", { method: "POST", body: { name: title } });
  const created = raw && (raw.playlist || raw);
  return playlistOf(created && created.guid ? created : { name: title });
}

export async function renamePlaylist({ id, name }) {
  await api("/playlist/edit", {
    method: "POST",
    body: { guid: str(id), name: str(name) },
  });
}

export async function deletePlaylist({ id }) {
  await api("/playlist/delete", { method: "POST", body: { guid: str(id) } });
}

export async function addToPlaylist({ id, trackIds }) {
  const ids = (Array.isArray(trackIds) ? trackIds : []).map(str).filter(Boolean);
  if (!ids.length) return;
  await api("/playlist/add-track", {
    method: "POST",
    body: { guid: str(id), trackGUIDs: ids },
  });
}

export async function removeFromPlaylist({ id, trackIds }) {
  const ids = (Array.isArray(trackIds) ? trackIds : []).map(str).filter(Boolean);
  if (!ids.length) return;
  await api("/playlist/remove-track", {
    method: "POST",
    body: { guid: str(id), trackGUIDs: ids },
  });
}

export async function lyrics({ id }) {
  const data = await api("/lyric/list", { query: { trackGUID: str(id) } });
  const list = Array.isArray(data && data.list) ? data.list : [];
  if (!list.length) return {};
  const preferred = str(data.preferred);
  const main = list.find((item) => str(item.guid) === preferred) || list[0];
  const content = str(main && main.content);
  if (!content) return {};
  return { lrc: content };
}

export async function stations() {
  return [
    {
      id: "roam",
      name: t("Roam"),
      description: t("Random songs from your library"),
    },
  ];
}

export async function stationNext({ id }) {
  if (str(id) !== "roam") fail("unsupported", t("No such station."));
  const deviceId = deviceID();
  let roamId = str(read("roamId"));

  if (!roamId) {
    const data = await api("/track/roam-start", { query: { deviceId } });
    const current = data && data.current;
    if (!current || !current.track) return [];
    write("roamId", str(current.roamId));
    const tracks = [trackOf(current.track)];
    if (data.next && data.next.track) tracks.push(trackOf(data.next.track));
    return tracks;
  }

  const data = await api("/track/roam-next", {
    query: { deviceId, relativeRoamId: roamId },
  });
  const next = data && data.next;
  if (!next || !next.track) return [];
  write("roamId", str(next.roamId) || roamId);
  return [trackOf(next.track)];
}

export async function stream({ id, quality }) {
  const guid = str(id);
  if (!guid) fail("unavailable", t("Track not found."));

  // fnOS transcodes to HLS, which MyGo Music's player doesn't take, so the
  // original file is streamed whatever quality was asked for.
  let format = formats.get(guid) || "";
  if (!format) {
    const data = await maybe(api("/track/metadata", { query: { guid } }));
    const track = (data && (data.track || data)) || {};
    format = str(track.audioSpec && track.audioSpec.format).toLowerCase();
    if (format) formats.set(guid, format);
  }

  const type = audioType(format);
  if (!type) {
    fail(
      "unavailable",
      t("MyGo Music can't play this track's format.") + (format ? " (" + format + ")" : ""),
    );
  }
  return { url: streamURL(guid), type, headers: authHeaders() };
}

// Tests only: forget everything kept between calls.
export function __reset() {
  cachedSession = null;
  favoritesCache = null;
  formats.clear();
  try {
    for (const key of ["token", "cookie", "accessHeader", "accessSource", "user", "roamId", "deviceId"]) {
      host.storage.remove(key);
    }
  } catch {
    // No storage in some tests.
  }
}

export const __test = { sha256Hex, normalizeServer, audioType, releaseText, base64 };
