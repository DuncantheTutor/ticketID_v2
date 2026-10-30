export function server() {
  return String(window.TICKETID_SERVER || "").trim().replace(/\/$/, "");
}

export function resolve(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return path;
  return server() + path;
}

function rewrite(value) {
  if (typeof value === "string") return value.startsWith("/media/") ? resolve(value) : value;
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = rewrite(value[key]);
  }
  return value;
}

function actor() {
  const value = window.TICKETID_ACTOR;
  if (value === "org" || value === "receiver") return value;
  return "fan";
}

function deviceId() {
  try {
    const native = window.TicketIdNative?.getDeviceId?.();
    if (native) {
      localStorage.setItem("ticketid.device", String(native));
      return String(native);
    }
  } catch {
    /* this page is not the Android app */
  }
  try {
    let id = localStorage.getItem("ticketid.device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("ticketid.device", id);
    }
    return id;
  } catch {
    return "";
  }
}

function appCheckToken() {
  try {
    return String(window.TicketIdNative?.getAppCheckToken?.() || window.__ticketidAppCheck || "");
  } catch {
    return "";
  }
}

function withFanDevice(path, body) {
  if (actor() !== "fan" || !body || typeof body !== "object" || Array.isArray(body)) return body;
  if (path !== "/api/fan/login" && path !== "/api/fan/signup") return body;
  return { ...body, deviceId: body.deviceId || deviceId() };
}

function accessKey() {
  return `ticketid.${actor()}`;
}

function refreshKey() {
  return `${accessKey()}.refresh`;
}

let memoryToken = "";

export function forgetSession() {
  memoryToken = "";
  try {
    localStorage.removeItem(accessKey());
    localStorage.removeItem(refreshKey());
  } catch {
    /* the page has no storage */
  }
}

function clearSession() {
  forgetSession();
}

function remember(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  try {
    if (data.token) {
      memoryToken = data.token;
      localStorage.setItem(accessKey(), data.token);
    }
    if (data.refreshToken) localStorage.setItem(refreshKey(), data.refreshToken);
  } catch {
    /* the page has no storage */
  }
}

async function refreshSession() {
  let refreshToken = "";
  try {
    refreshToken = localStorage.getItem(refreshKey()) || "";
  } catch {
    return null;
  }
  if (!refreshToken) return null;
  let response;
  try {
    response = await fetch(resolve("/api/session/refresh"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    const failure = new Error(server() ? "The ticketID server could not be reached." : "Something went wrong.");
    failure.status = 0;
    throw failure;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    if (response.status === 401) clearSession();
    return null;
  }
  remember(data);
  return data.token;
}

export async function api(path, options = {}) {
  if (path === "/api/logout") clearSession();
  const token = options.retried ? options.token : (memoryToken || options.token);
  const body = withFanDevice(path, options.body);
  const attest = appCheckToken();
  let response;
  try {
    response = await fetch(resolve(path), {
      method: options.method || "GET",
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(attest ? { "x-firebase-appcheck": attest } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const failure = new Error(server() ? "The ticketID server could not be reached." : "Something went wrong.");
    failure.status = 0;
    throw failure;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !options.retried && path !== "/api/session/refresh" && path !== "/api/logout") {
      try {
        const next = await refreshSession();
        if (next) return api(path, { ...options, token: next, retried: true });
      } catch (cause) {
        if (cause?.status === 0) throw cause;
      }
    }
    const failure = new Error(data.message || "Something went wrong.");
    failure.status = response.status;
    throw failure;
  }
  remember(data);
  return rewrite(data);
}
