/**
 * Minimal fetch client for the Recipe Finder & Saver frontend.
 * Uses REACT_APP_API_BASE_URL if set; otherwise uses same-origin.
 */

const DEFAULT_TIMEOUT_MS = 20000;

const TOKEN_STORAGE_KEY = 'rf_access_token';

// PUBLIC_INTERFACE
export function getAccessToken() {
  /** Return the currently stored JWT access token (or empty string). */
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

// PUBLIC_INTERFACE
export function setAccessToken(token) {
  /** Persist a JWT access token for subsequent API calls. */
  try {
    if (!token) window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    else window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore storage failures (e.g., privacy mode)
  }
}

/**
 * @returns {string}
 */
function getApiBaseUrl() {
  // If deploying FE and BE separately, set REACT_APP_API_BASE_URL accordingly.
  // Example: https://example.com/api or https://...:3001
  return (process.env.REACT_APP_API_BASE_URL || '').replace(/\/+$/, '');
}

/**
 * @param {string} path
 * @returns {string}
 */
function urlFor(path) {
  const base = getApiBaseUrl();
  if (!path.startsWith('/')) path = `/${path}`;
  return base ? `${base}${path}` : path;
}

function makeAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const t = window.setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cleanup: () => window.clearTimeout(t) };
}

/**
 * @param {Response} res
 */
async function parseJsonOrText(res) {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  const text = await res.text();
  // Best-effort JSON parse
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{ body?: any, headers?: Record<string,string>, timeoutMs?: number }} [options]
 */
async function request(method, path, options = {}) {
  const { body, headers, timeoutMs } = options;
  const { signal, cleanup } = makeAbortSignal(timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const token = getAccessToken();

  try {
    const res = await fetch(urlFor(path), {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    const payload = await parseJsonOrText(res);

    if (!res.ok) {
      const serverMessage =
        typeof payload === 'string'
          ? payload
          : payload?.detail || payload?.message || JSON.stringify(payload);
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${serverMessage}`);
    }

    return payload;
  } catch (e) {
    // Normalize AbortError
    if (e?.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw e;
  } finally {
    cleanup();
  }
}

// PUBLIC_INTERFACE
export async function apiGetHealth() {
  /** Health check. Returns {} or any JSON payload. */
  return request('GET', '/');
}

// PUBLIC_INTERFACE
export async function apiRegister({ email, password, display_name }) {
  /** Register a new user and store returned JWT. */
  const data = await request('POST', '/auth/register', {
    body: { email, password, display_name: display_name || null },
  });
  if (data?.access_token) setAccessToken(data.access_token);
  return data;
}

// PUBLIC_INTERFACE
export async function apiLogin({ email, password }) {
  /** Login and store returned JWT. */
  const data = await request('POST', '/auth/login', { body: { email, password } });
  if (data?.access_token) setAccessToken(data.access_token);
  return data;
}

// PUBLIC_INTERFACE
export async function apiGetMe() {
  /** Fetch the current user profile using the stored JWT. */
  return request('GET', '/auth/me');
}

// PUBLIC_INTERFACE
export async function apiLogout() {
  /** Logout is client-side for JWT-based auth. */
  setAccessToken('');
  try {
    return await request('POST', '/auth/logout');
  } catch (e) {
    // Backend logout is convenience-only; ignore failures.
    return { message: 'Logged out' };
  }
}

/**
 * Search recipes.
 * Backend endpoint may evolve; we try common conventions:
 * - GET /recipes/search?q=...
 * - GET /recipes?q=...
 */
// PUBLIC_INTERFACE
export async function apiSearchRecipes({ q }) {
  /** Search recipes by query string. */
  const query = encodeURIComponent(q || '');
  // Prefer /recipes/search but fall back to /recipes if needed.
  try {
    return await request('GET', `/recipes/search?q=${query}`);
  } catch (e) {
    return request('GET', `/recipes?q=${query}`);
  }
}

/**
 * Recipe detail:
 * - GET /recipes/{id}
 */
// PUBLIC_INTERFACE
export async function apiGetRecipeById(id) {
  /** Fetch a single recipe by id. */
  return request('GET', `/recipes/${encodeURIComponent(String(id))}`);
}

/**
 * Saved recipes:
 * - GET /favorites or /saved
 * Optionally filter by username:
 * - GET /favorites?username=...
 */
// PUBLIC_INTERFACE
export async function apiGetSavedRecipes({ username } = {}) {
  /** Get saved/favorite recipes list. (username is ignored by this backend; kept for backward compatibility) */
  const qs = username ? `?username=${encodeURIComponent(username)}` : '';
  try {
    const data = await request('GET', `/favorites${qs}`);
    // Backend returns { items: [{ recipe, created_at }], total }
    if (data && Array.isArray(data.items)) return data.items.map((it) => it.recipe);
    return data;
  } catch (e) {
    return request('GET', `/saved${qs}`);
  }
}

/**
 * Save recipe:
 * - POST /favorites
 * - POST /saved
 *
 * Some backends accept {recipe: {...}, username?}; others accept raw recipe.
 */
// PUBLIC_INTERFACE
export async function apiSaveRecipe(recipe, { username } = {}) {
  /** Save/favorite a recipe. This backend requires Bearer JWT and expects { recipe_id }. */
  const recipeId = recipe?.id ?? recipe?.recipe_id ?? recipe?._id ?? recipe?.uuid;
  if (!recipeId) throw new Error('Cannot save recipe: missing recipe id.');

  // username is ignored by backend; kept for backward compatibility.
  const body = { recipe_id: String(recipeId) };

  try {
    return await request('POST', '/favorites', { body });
  } catch (e) {
    // Fallback variants for older backends
    try {
      return await request('POST', '/saved', { body: username ? { username, recipe } : { recipe } });
    } catch (e2) {
      throw e;
    }
  }
}

/**
 * Unsave recipe:
 * - DELETE /favorites/{id}
 * - DELETE /saved/{id}
 * Some backends use query param username.
 */
// PUBLIC_INTERFACE
export async function apiUnsaveRecipe(id, { username } = {}) {
  /** Remove recipe from saved/favorites. */
  const qs = username ? `?username=${encodeURIComponent(username)}` : '';
  try {
    return await request('DELETE', `/favorites/${encodeURIComponent(String(id))}${qs}`);
  } catch (e) {
    return request('DELETE', `/saved/${encodeURIComponent(String(id))}${qs}`);
  }
}
