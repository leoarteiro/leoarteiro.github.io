// LNURL-Pay (LUD-06/12/16) via Lightning Address, plus optional WebLN payment.

export async function requestInvoice(address, sats, comment) {
  if (!Number.isInteger(sats) || sats <= 0) throw new RangeError("sats must be a positive integer");
  const [user, domain] = address.split("@");
  if (!user || !domain) throw new Error("invalid lightning address");

  const params = await (await fetch(`https://${domain}/.well-known/lnurlp/${user}`)).json();
  if (params.tag !== "payRequest") throw new Error(params.reason || "not a payRequest");

  const msats = sats * 1000;
  if (msats < params.minSendable || msats > params.maxSendable) {
    throw new RangeError(`amount out of range (${params.minSendable / 1000}–${params.maxSendable / 1000} sats)`);
  }

  const url = new URL(params.callback);
  url.searchParams.set("amount", String(msats));
  if (comment && params.commentAllowed) url.searchParams.set("comment", comment.slice(0, params.commentAllowed));

  const res = await (await fetch(url)).json();
  if (!res.pr) throw new Error(res.reason || "no invoice returned");
  return res.pr;
}

export const hasWebLN = () => typeof window.webln !== "undefined";

export async function payWithWebLN(invoice) {
  await window.webln.enable();
  return window.webln.sendPayment(invoice);
}
