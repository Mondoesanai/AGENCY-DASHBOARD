// Freeze/advance "now" so billing-day logic can be tested on chosen dates.
const RealDate = Date;
let NOW = RealDate.parse('2026-09-19T14:00:00Z');
export function setNow(iso) {
  NOW = RealDate.parse(iso);
}
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(NOW);
    else super(...a);
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = FakeDate;
