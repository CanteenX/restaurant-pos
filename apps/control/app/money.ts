const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export function formatInr(amountPaise: number) {
  const paise = BigInt(amountPaise);
  const paisePerRupee = BigInt(100);
  const remainder = (paise % paisePerRupee).toString().padStart(2, '0');
  return inr.formatToParts(paise / paisePerRupee).map(({ type, value }) => type === 'fraction' ? remainder : value).join('');
}
