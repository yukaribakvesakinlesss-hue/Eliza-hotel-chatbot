/** Display names for the account codes in public.usali_accounts (kept in sync with migration 0004). */
export const ACCOUNT_LABELS: Record<string, { tr: string; en: string; schedule: string }> = {
  ROOMS_TRANSIENT: { tr: 'Oda geliri (konaklama)', en: 'Rooms revenue – transient', schedule: 'Rooms' },
  ROOMS_NO_SHOW: { tr: 'Oda geliri (no-show)', en: 'Rooms revenue – no-show', schedule: 'Rooms' },
  ROOMS_ALLOWANCE: { tr: 'Oda indirimleri', en: 'Rooms allowances', schedule: 'Rooms' },
  FB_FOOD: { tr: 'Yiyecek geliri', en: 'Food revenue', schedule: 'Food and Beverage' },
  FB_BEVERAGE: { tr: 'İçecek / minibar geliri', en: 'Beverage revenue', schedule: 'Food and Beverage' },
  OOD_OTHER: { tr: 'Diğer hizmet geliri', en: 'Other operated departments', schedule: 'Other Operated Departments' },
  MISC_INCOME: { tr: 'Diğer gelirler', en: 'Miscellaneous income', schedule: 'Miscellaneous Income' },
  TAX_VAT: { tr: 'KDV (tahsil edilen)', en: 'VAT payable', schedule: 'Balance sheet – taxes payable' },
  TAX_LODGING: { tr: 'Konaklama vergisi', en: 'Lodging tax payable', schedule: 'Balance sheet – taxes payable' },
  SETTLEMENT_CASH: { tr: 'Tahsilat – nakit', en: 'Settlement – cash', schedule: 'Balance sheet – cash / guest ledger' },
  SETTLEMENT_CARD: { tr: 'Tahsilat – kart', en: 'Settlement – card', schedule: 'Balance sheet – cash / guest ledger' },
  SETTLEMENT_TRANSFER: { tr: 'Tahsilat – havale', en: 'Settlement – bank transfer', schedule: 'Balance sheet – cash / guest ledger' },
  SETTLEMENT_OTA: { tr: 'Tahsilat – OTA (sanal kart)', en: 'Settlement – OTA collect', schedule: 'Balance sheet – accounts receivable' },
  ROOMS_COMMISSIONS: { tr: 'Komisyon gideri (OTA)', en: 'Rooms expense – commissions', schedule: 'Rooms – other expenses' }
};

export const ACCOUNT_ORDER = Object.keys(ACCOUNT_LABELS);

/** Extras offered at the front desk, with demo VAT rates (Türkiye: food 10 %, drinks/other 20 %). */
export const EXTRA_PRESETS = [
  { account: 'FB_FOOD', tr: 'Yiyecek', en: 'Food', taxRate: 0.1 },
  { account: 'FB_BEVERAGE', tr: 'İçecek / minibar', en: 'Beverage / minibar', taxRate: 0.2 },
  { account: 'OOD_OTHER', tr: 'Diğer hizmet (transfer, çamaşır…)', en: 'Other service (transfer, laundry…)', taxRate: 0.2 },
  { account: 'MISC_INCOME', tr: 'Diğer gelir', en: 'Miscellaneous', taxRate: 0.2 }
] as const;
