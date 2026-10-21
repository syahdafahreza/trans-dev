/**
 * Tiny dependency-free router. Patterns look like `/api/fs/list` or
 * `/api/relay/session/:id`; params come back as a plain object.
 */
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean);
    routes.push({ method, segments, handler });
    return api;
  }

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  const api = {
    get: (pattern, handler) => add('GET', pattern, handler),
    head: (pattern, handler) => add('HEAD', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    match,
    routes,
  };
  return api;
}
