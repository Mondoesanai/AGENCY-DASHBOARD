// The client-site registry. This is the ONLY thing you edit when you launch
// a new site: add one line here, done. Everything else is automatic.
//
//   slug   - short id, also the value you (optionally) put in the snippet
//   name   - client / business name shown in the dashboard + emails
//   url    - the live homepage URL (used for the free SEO + speed audit)
//   client - contact name for the monthly email greeting
//   email  - where the monthly report goes (leave "" to skip sending)

export const SITES = [
  {
    slug: 'relax-tax',
    name: 'Relax Tax',
    url: 'https://relax-tax.vercel.app',
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
  // add new sites here ...
];

export function getSite(slug) {
  return SITES.find((s) => s.slug === slug) || null;
}
