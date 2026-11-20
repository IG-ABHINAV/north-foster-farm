// The shape of an order id the site draws: NFF-, the year and month,
// and four characters (NFF-2611-K3WM). Alone here so lib/store.mjs can
// know one in a key without loading the Square client.
export const ORDER_ID = /^NFF-\d{4}-[A-Z0-9]{4}$/;
