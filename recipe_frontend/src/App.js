import React, { useEffect, useMemo, useState } from 'react';
import './App.css';
import {
  apiGetHealth,
  apiSearchRecipes,
  apiGetRecipeById,
  apiGetSavedRecipes,
  apiSaveRecipe,
  apiUnsaveRecipe,
} from './api/client';

/**
 * Small helper for consistent, user-friendly error messages.
 * @param {unknown} err
 * @returns {string}
 */
function toErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || 'Unknown error';
  return 'Unknown error';
}

function classNames(...names) {
  return names.filter(Boolean).join(' ');
}

/**
 * Lightweight debounce hook for search inputs.
 * @param {string} value
 * @param {number} delayMs
 */
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}

function formatTime(dt) {
  try {
    const d = new Date(dt);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString();
  } catch {
    return '';
  }
}

function isNonEmptyString(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

function normalizeRecipe(raw) {
  // Backend spec is not yet fully defined (OpenAPI currently has only /),
  // so we normalize common fields to keep UI resilient as backend evolves.
  const id = raw?.id ?? raw?.recipe_id ?? raw?._id ?? raw?.uuid;
  const title = raw?.title ?? raw?.name ?? raw?.recipe_title ?? 'Untitled recipe';
  const imageUrl = raw?.image_url ?? raw?.imageUrl ?? raw?.thumbnail ?? '';
  const sourceUrl = raw?.source_url ?? raw?.sourceUrl ?? raw?.url ?? '';
  const summary = raw?.summary ?? raw?.description ?? '';
  const ingredients =
    raw?.ingredients ??
    raw?.ingredient_lines ??
    raw?.ingredientLines ??
    raw?.items ??
    [];
  const instructions = raw?.instructions ?? raw?.steps ?? raw?.directions ?? [];

  return {
    raw,
    id,
    title,
    imageUrl,
    sourceUrl,
    summary,
    ingredients: Array.isArray(ingredients) ? ingredients : [],
    instructions: Array.isArray(instructions) ? instructions : [],
  };
}

function RecipeCard({ recipe, isSaved, onOpen, onToggleSave, busy }) {
  const thumb = isNonEmptyString(recipe.imageUrl) ? recipe.imageUrl : null;

  return (
    <article className="rf-card" aria-label={`Recipe: ${recipe.title}`}>
      <button type="button" className="rf-card__media" onClick={onOpen}>
        {thumb ? (
          <img className="rf-card__img" src={thumb} alt={recipe.title} loading="lazy" />
        ) : (
          <div className="rf-card__img rf-card__img--placeholder" aria-hidden="true">
            <div className="rf-pixel-badge">NO IMG</div>
          </div>
        )}
      </button>

      <div className="rf-card__body">
        <div className="rf-card__titleRow">
          <h3 className="rf-card__title">{recipe.title}</h3>
          <span className={classNames('rf-chip', isSaved ? 'rf-chip--saved' : 'rf-chip--ghost')}>
            {isSaved ? 'SAVED' : 'NEW'}
          </span>
        </div>

        {isNonEmptyString(recipe.summary) ? (
          <p className="rf-card__summary">{recipe.summary}</p>
        ) : (
          <p className="rf-card__summary rf-card__summary--muted">
            A mysterious recipe emerges from the CRT glow…
          </p>
        )}

        <div className="rf-card__actions">
          <button type="button" className="rf-btn rf-btn--secondary" onClick={onOpen}>
            View
          </button>

          <button
            type="button"
            className={classNames('rf-btn', isSaved ? 'rf-btn--danger' : 'rf-btn--primary')}
            onClick={onToggleSave}
            disabled={busy}
            aria-busy={busy ? 'true' : 'false'}
            title={isSaved ? 'Remove from saved recipes' : 'Save this recipe'}
          >
            {busy ? '…' : isSaved ? 'Unsave' : 'Save'}
          </button>
        </div>
      </div>
    </article>
  );
}

function Modal({ title, children, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="rf-modalOverlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="rf-modal">
        <div className="rf-modal__header">
          <h2 className="rf-modal__title">{title}</h2>
          <button type="button" className="rf-btn rf-btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="rf-modal__body">{children}</div>
      </div>
      <button type="button" className="rf-modalOverlay__backdrop" onClick={onClose} aria-label="Close modal" />
    </div>
  );
}

// PUBLIC_INTERFACE
function App() {
  const [theme, setTheme] = useState('light');

  // Basic "auth" placeholder: backend may evolve to real auth later.
  // We keep a username in localStorage so saved recipes feel personal.
  const [username, setUsername] = useState(() => window.localStorage.getItem('rf_username') || '');

  // Search state
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 350);
  const [searchResults, setSearchResults] = useState([]);
  const [searchStatus, setSearchStatus] = useState({ loading: false, error: '', lastUpdated: '' });

  // Saved recipes state
  const [saved, setSaved] = useState([]);
  const [savedStatus, setSavedStatus] = useState({ loading: false, error: '', lastUpdated: '' });

  // Selected recipe (for modal)
  const [selected, setSelected] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState({ loading: false, error: '' });

  // Per-recipe save/un-save busy states
  const [saveBusyIds, setSaveBusyIds] = useState(() => new Set());

  // Health indicator
  const [health, setHealth] = useState({ ok: true, error: '' });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('rf_username', username);
  }, [username]);

  const savedIds = useMemo(() => new Set(saved.map((r) => normalizeRecipe(r).id)), [saved]);

  // Initial backend health check + load saved
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        await apiGetHealth();
        if (!cancelled) setHealth({ ok: true, error: '' });
      } catch (e) {
        if (!cancelled) setHealth({ ok: false, error: toErrorMessage(e) });
      }

      // Saved list is optional but central to the app experience.
      // Load it even if health check fails; backend may still respond.
      reloadSaved();
    }

    init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Search as the user types (debounced)
  useEffect(() => {
    let cancelled = false;

    async function doSearch() {
      const q = debouncedQuery.trim();
      if (!q) {
        setSearchResults([]);
        setSearchStatus((s) => ({ ...s, loading: false, error: '', lastUpdated: '' }));
        return;
      }

      setSearchStatus({ loading: true, error: '', lastUpdated: '' });
      try {
        const data = await apiSearchRecipes({ q });
        const list = Array.isArray(data) ? data : data?.results ?? data?.recipes ?? [];
        const normalized = list.map(normalizeRecipe).filter((r) => r.id != null);
        if (!cancelled) {
          setSearchResults(normalized);
          setSearchStatus({ loading: false, error: '', lastUpdated: new Date().toISOString() });
        }
      } catch (e) {
        if (!cancelled) {
          setSearchResults([]);
          setSearchStatus({ loading: false, error: toErrorMessage(e), lastUpdated: '' });
        }
      }
    }

    doSearch();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  async function reloadSaved() {
    setSavedStatus({ loading: true, error: '', lastUpdated: '' });
    try {
      const data = await apiGetSavedRecipes({ username: username.trim() || undefined });
      const list = Array.isArray(data) ? data : data?.results ?? data?.recipes ?? data?.saved ?? [];
      const normalized = list.map(normalizeRecipe).filter((r) => r.id != null);
      setSaved(normalized);
      setSavedStatus({ loading: false, error: '', lastUpdated: new Date().toISOString() });
    } catch (e) {
      setSaved([]);
      setSavedStatus({ loading: false, error: toErrorMessage(e), lastUpdated: '' });
    }
  }

  // PUBLIC_INTERFACE
  const toggleTheme = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));

  async function openRecipe(recipe) {
    setSelected(recipe);
    setSelectedStatus({ loading: true, error: '' });

    const id = recipe?.id;
    if (id == null) {
      setSelectedStatus({ loading: false, error: 'Recipe is missing an id.' });
      return;
    }

    try {
      const detail = await apiGetRecipeById(id);
      setSelected(normalizeRecipe(detail));
      setSelectedStatus({ loading: false, error: '' });
    } catch (e) {
      // If backend doesn't support recipe-by-id yet, keep card data and show error.
      setSelectedStatus({ loading: false, error: toErrorMessage(e) });
    }
  }

  function closeRecipe() {
    setSelected(null);
    setSelectedStatus({ loading: false, error: '' });
  }

  async function toggleSave(recipe) {
    const id = recipe?.id;
    if (id == null) return;

    // Mark busy
    setSaveBusyIds((prev) => new Set(prev).add(id));

    const currentlySaved = savedIds.has(id);

    try {
      if (currentlySaved) {
        await apiUnsaveRecipe(id, { username: username.trim() || undefined });
      } else {
        // Send the normalized recipe raw payload so backend can choose what it persists.
        await apiSaveRecipe(
          {
            id: recipe.id,
            title: recipe.title,
            image_url: recipe.imageUrl,
            source_url: recipe.sourceUrl,
            summary: recipe.summary,
            ingredients: recipe.ingredients,
            instructions: recipe.instructions,
            raw: recipe.raw,
          },
          { username: username.trim() || undefined }
        );
      }

      await reloadSaved();
    } catch (e) {
      // Surface errors in saved status area for visibility
      setSavedStatus((s) => ({ ...s, error: toErrorMessage(e) }));
    } finally {
      setSaveBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="App">
      <header className="rf-header">
        <div className="rf-header__inner">
          <div className="rf-brand" aria-label="Recipe Finder & Saver">
            <div className="rf-brand__logo" aria-hidden="true">
              RF
            </div>
            <div className="rf-brand__text">
              <div className="rf-brand__title">Recipe Finder &amp; Saver</div>
              <div className="rf-brand__subtitle">Retro CRT edition</div>
            </div>
          </div>

          <div className="rf-header__actions">
            <div className="rf-connection" title="Backend connection status">
              <span className={classNames('rf-dot', health.ok ? 'rf-dot--ok' : 'rf-dot--bad')} aria-hidden="true" />
              <span className="rf-connection__text">
                {health.ok ? 'Backend: online' : 'Backend: offline'}
              </span>
            </div>

            <button
              className="rf-btn rf-btn--secondary"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              title="Toggle theme"
              type="button"
            >
              {theme === 'light' ? 'Dark' : 'Light'}
            </button>
          </div>
        </div>
      </header>

      <main className="rf-main">
        <section className="rf-panel rf-panel--top">
          <div className="rf-grid2">
            <div className="rf-block">
              <h1 className="rf-h1">Find recipes</h1>
              <p className="rf-muted">
                Type ingredients, cuisines, or cravings. Results stream in like a dial-up download.
              </p>

              <form
                className="rf-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  // Search is handled by debounced effect; submitting just prevents default.
                }}
              >
                <label className="rf-label" htmlFor="rf-q">
                  Search
                </label>
                <div className="rf-search__row">
                  <input
                    id="rf-q"
                    className="rf-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g. chicken, lemon, pasta…"
                    autoComplete="off"
                  />
                  <button
                    className="rf-btn rf-btn--primary"
                    type="button"
                    onClick={() => {
                      // Force effect to run by setting query to same value won't.
                      // So we do a small trim-toggle trick.
                      setQuery((v) => (v.endsWith(' ') ? v.trimEnd() : `${v} `));
                    }}
                    disabled={!query.trim()}
                    title="Refresh results"
                  >
                    Search
                  </button>
                </div>

                <div className="rf-statusRow" role="status" aria-live="polite">
                  {searchStatus.loading ? (
                    <span className="rf-pill rf-pill--loading">Loading…</span>
                  ) : searchStatus.error ? (
                    <span className="rf-pill rf-pill--error">Error: {searchStatus.error}</span>
                  ) : debouncedQuery.trim() ? (
                    <span className="rf-pill rf-pill--ok">
                      {searchResults.length} result{searchResults.length === 1 ? '' : 's'}
                      {searchStatus.lastUpdated ? ` • ${formatTime(searchStatus.lastUpdated)}` : ''}
                    </span>
                  ) : (
                    <span className="rf-pill rf-pill--ghost">Tip: try “tacos”, “tofu”, “garlic”</span>
                  )}
                </div>
              </form>
            </div>

            <div className="rf-block">
              <h2 className="rf-h2">Pilot profile</h2>
              <p className="rf-muted">Saved recipes can be filtered by your handle (optional).</p>

              <label className="rf-label" htmlFor="rf-user">
                Username (optional)
              </label>
              <div className="rf-search__row">
                <input
                  id="rf-user"
                  className="rf-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. pixelchef42"
                  autoComplete="off"
                />
                <button className="rf-btn rf-btn--secondary" type="button" onClick={reloadSaved}>
                  Reload saved
                </button>
              </div>

              <div className="rf-statusRow" role="status" aria-live="polite">
                {savedStatus.loading ? (
                  <span className="rf-pill rf-pill--loading">Loading saved…</span>
                ) : savedStatus.error ? (
                  <span className="rf-pill rf-pill--error">Error: {savedStatus.error}</span>
                ) : (
                  <span className="rf-pill rf-pill--ok">
                    {saved.length} saved
                    {savedStatus.lastUpdated ? ` • ${formatTime(savedStatus.lastUpdated)}` : ''}
                  </span>
                )}
              </div>

              {!health.ok && health.error ? (
                <div className="rf-callout rf-callout--warn">
                  <div className="rf-callout__title">Backend not reachable</div>
                  <div className="rf-callout__body">
                    The UI will still render, but fetch calls may fail.
                    <div className="rf-mono">Details: {health.error}</div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="rf-panel">
          <div className="rf-panel__header">
            <h2 className="rf-h2">Search results</h2>
            <div className="rf-muted">
              Click a card to view details. Save the ones you love.
            </div>
          </div>

          {debouncedQuery.trim() && !searchStatus.loading && !searchStatus.error && searchResults.length === 0 ? (
            <div className="rf-empty">
              <div className="rf-empty__title">No results</div>
              <div className="rf-empty__body">Try a different keyword or fewer ingredients.</div>
            </div>
          ) : null}

          <div className="rf-gridCards" aria-label="Search results">
            {searchResults.map((r) => (
              <RecipeCard
                key={String(r.id)}
                recipe={r}
                isSaved={savedIds.has(r.id)}
                onOpen={() => openRecipe(r)}
                onToggleSave={() => toggleSave(r)}
                busy={saveBusyIds.has(r.id)}
              />
            ))}
          </div>
        </section>

        <section className="rf-panel">
          <div className="rf-panel__header">
            <h2 className="rf-h2">Saved recipes</h2>
            <div className="rf-muted">Your stash, preserved in 16-bit glory.</div>
          </div>

          {!savedStatus.loading && !savedStatus.error && saved.length === 0 ? (
            <div className="rf-empty">
              <div className="rf-empty__title">Nothing saved yet</div>
              <div className="rf-empty__body">Save a recipe from the search results to see it here.</div>
            </div>
          ) : null}

          <div className="rf-gridCards" aria-label="Saved recipes">
            {saved.map((r) => (
              <RecipeCard
                key={String(r.id)}
                recipe={normalizeRecipe(r)}
                isSaved={true}
                onOpen={() => openRecipe(normalizeRecipe(r))}
                onToggleSave={() => toggleSave(normalizeRecipe(r))}
                busy={saveBusyIds.has(normalizeRecipe(r).id)}
              />
            ))}
          </div>
        </section>
      </main>

      <footer className="rf-footer">
        <div className="rf-footer__inner">
          <div className="rf-muted">
            Recipe Finder &amp; Saver • built with React • retro theme UI
          </div>
          <div className="rf-muted rf-mono">
            API base: {process.env.REACT_APP_API_BASE_URL || '(same origin)'}
          </div>
        </div>
      </footer>

      {selected ? (
        <Modal title={selected.title} onClose={closeRecipe}>
          {selectedStatus.loading ? (
            <div className="rf-loadingPane">Loading recipe details…</div>
          ) : selectedStatus.error ? (
            <div className="rf-callout rf-callout--warn">
              <div className="rf-callout__title">Could not load full details</div>
              <div className="rf-callout__body">
                Showing best-effort info from search results.
                <div className="rf-mono">Details: {selectedStatus.error}</div>
              </div>
            </div>
          ) : null}

          <div className="rf-detail">
            <div className="rf-detail__top">
              <div className="rf-detail__thumb">
                {isNonEmptyString(selected.imageUrl) ? (
                  <img className="rf-detail__img" src={selected.imageUrl} alt={selected.title} />
                ) : (
                  <div className="rf-detail__img rf-card__img--placeholder" aria-hidden="true">
                    <div className="rf-pixel-badge">NO IMG</div>
                  </div>
                )}
              </div>

              <div className="rf-detail__meta">
                <div className="rf-detail__actions">
                  <button
                    type="button"
                    className={classNames(
                      'rf-btn',
                      savedIds.has(selected.id) ? 'rf-btn--danger' : 'rf-btn--primary'
                    )}
                    onClick={() => toggleSave(selected)}
                    disabled={saveBusyIds.has(selected.id)}
                  >
                    {saveBusyIds.has(selected.id) ? '…' : savedIds.has(selected.id) ? 'Unsave' : 'Save'}
                  </button>

                  {isNonEmptyString(selected.sourceUrl) ? (
                    <a className="rf-btn rf-btn--secondary" href={selected.sourceUrl} target="_blank" rel="noreferrer">
                      Source
                    </a>
                  ) : null}
                </div>

                {isNonEmptyString(selected.summary) ? (
                  <p className="rf-detail__summary">{selected.summary}</p>
                ) : (
                  <p className="rf-detail__summary rf-muted">
                    No summary available. Proceed with culinary confidence.
                  </p>
                )}

                <div className="rf-detail__chips">
                  <span className={classNames('rf-chip', savedIds.has(selected.id) ? 'rf-chip--saved' : 'rf-chip--ghost')}>
                    {savedIds.has(selected.id) ? 'SAVED' : 'UNSAVED'}
                  </span>
                  {selected.ingredients.length ? (
                    <span className="rf-chip rf-chip--ghost">{selected.ingredients.length} ingredients</span>
                  ) : null}
                  {selected.instructions.length ? (
                    <span className="rf-chip rf-chip--ghost">{selected.instructions.length} steps</span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="rf-detail__cols">
              <section className="rf-detail__section">
                <h3 className="rf-h3">Ingredients</h3>
                {selected.ingredients.length ? (
                  <ul className="rf-list">
                    {selected.ingredients.map((ing, idx) => (
                      <li key={idx} className="rf-list__item">
                        {typeof ing === 'string' ? ing : JSON.stringify(ing)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="rf-muted">No ingredients provided.</div>
                )}
              </section>

              <section className="rf-detail__section">
                <h3 className="rf-h3">Instructions</h3>
                {selected.instructions.length ? (
                  <ol className="rf-steps">
                    {selected.instructions.map((step, idx) => (
                      <li key={idx} className="rf-steps__item">
                        {typeof step === 'string' ? step : JSON.stringify(step)}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="rf-muted">No instructions provided.</div>
                )}
              </section>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export default App;
