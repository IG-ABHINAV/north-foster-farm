// The delivery the order page posts, for a new order and for ?edit=
// alike (#626). Only the form's own fields: never `toGroup`, so an
// edit of an order stored with it (#471) keeps the stored value, which
// lib/edit.mjs `payloadFor` merges under what is posted.

const KEYS = ["address1", "address2", "town", "zip", "cooler", "notes"];

// `values` is the form's delivery fields by name; anything else in it
// is ignored. -> { address1, address2, town, zip, cooler, notes }
export const postedDelivery = (values) => {
  const v = values && typeof values === "object" ? values : {};

  return Object.fromEntries(KEYS.map((key) => [key, v[key]]));
};
