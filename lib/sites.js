// Seed registry. You normally add sites from the dashboard's "Add site" button
// now (those live in the database). This file is just a starting list + a place
// to hard-code overrides. A database entry with the same slug wins.
//
//   slug   - short id
//   name   - business name
//   url    - live homepage URL (used for the SEO / speed / uptime checks)
//   client - contact first name (email greeting)
//   email  - where the monthly report goes ('' to skip)

export const SITES = [
  {
    slug: 'relax-tax',
    name: 'Relax Tax',
    url: 'https://relaxtax.vercel.app',
    client: 'Kyle',
    email: '',
  },
  {
    slug: 'apostello-detailing',
    name: 'Apostello Detailing',
    url: 'https://apostellodetailing.vercel.app',
    client: 'Shiloh',
    email: '',
  },
  {
    slug: 'one-more-thing',
    name: 'One More Thing Services',
    url: 'https://one-more-thing-gold.vercel.app',
    client: 'Angie',
    email: '',
  },
];

export function getSite(slug) {
  return SITES.find((s) => s.slug === slug) || null;
}
