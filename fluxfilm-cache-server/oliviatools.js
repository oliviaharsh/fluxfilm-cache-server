/**
 * FluxFilm - Olivia's TOOLS: the only website functions Olivia may call. Each one is the SAME function the storefront
 * uses, with the same checks (maintenance guard, stock, coupon-free price, payment matching, who may see a login).
 * Olivia never writes SQL for orders/payments/credentials herself.
 *
 *   catalogFor()                       → { plans, stock }         (getBootstrap + getStockLevels)
 *   profile(phone)                     → { ok, name, email }      (reads.getCustomerProfile)
 *   createOrder(phone, plan, extra)    → createOrder result        (store guard first, exactly like /api createOrder)
 *   checkPayment(orderId)              → { paid }                  (order.verifyPayment: bank email + learned payer names)
 *   deliver(orderId, phone)            → fulfillAndGetAccess result (phone proof; renew orders are never created here)
 *   backupPayment(orderId, phone)      → getBackupPayment          ("payment not working" → plain QR)
 *   claimBackup(orderId, phone, name)  → claimManualPayment
 *   claimStatus(orderId, phone)        → getClaimStatus
 */
function make(deps) {
  const d = deps || {};
  const lazy = (name, file) => () => (d[name] || (d[name] = require(file)));
  const catalog = lazy('catalog', './catalog');
  const reads = lazy('reads', './reads');
  const order = lazy('order', './order');
  const fulfill = lazy('fulfill', './fulfill');
  const paymatch = lazy('paymatch', './paymatch');
  const store = lazy('store', './store');

  return {
    async catalogFor() {
      const [boot, stock] = await Promise.all([catalog().getBootstrap(), catalog().getStockLevels().catch(() => null)]);
      return { plans: (boot && boot.ok && Array.isArray(boot.plans)) ? boot.plans : [], stock: (stock && stock.levels) || {} };
    },
    async profile(phone) {
      const r = await reads().getCustomerProfile(phone);
      return r && r.ok ? { ok: true, name: String(r.name || ''), email: String(r.email || '') } : { ok: false };
    },
    async createOrder(phone, p, extra) {
      const paused = await store().guard();
      if (paused) return paused;
      return order().createOrder({
        service: p.service, plan: p.plan, phone, name: extra.name, email: extra.email,
        extraFieldKey: extra.extraFieldKey || '', extraFieldValue: extra.extraFieldValue || '',
        notes: 'Ordered in Olivia chat',
      });
    },
    async checkPayment(orderId) {
      const r = await order().verifyPayment(orderId);
      return { paid: !!(r && r.paid), ok: !!(r && r.ok) };
    },
    deliver: (orderId, phone) => fulfill().fulfillAndGetAccess(orderId, { phone }),
    backupPayment: (orderId, phone) => paymatch().getBackupPayment(orderId, { phone }),
    claimBackup: (orderId, phone, name) => paymatch().claimPayment(orderId, { phone }, name, ''),
    claimStatus: (orderId, phone) => paymatch().getClaimStatus(orderId, { phone }),
  };
}

module.exports = { make };
