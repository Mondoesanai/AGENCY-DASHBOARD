// Seed sites. Normally empty — sites are added from the dashboard's
// "+ Add site" button, or auto-register the first time the tracker snippet
// fires on them. Only hard-code an entry here if you want it to always exist
// even after being removed in the UI.
export const SITES = [];

export function getSite(slug) {
  return SITES.find((s) => s.slug === slug) || null;
}
