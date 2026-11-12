// Example of DOM-based extraction on a page we control.
// This is NOT a scraper for Google Flights, Kayak, or any real provider.
function euro(text) {
  if (text.trim().toLowerCase() === 'included') return 0;
  const amount = Number(text.replace(/[^\d.,]/g,'').replace(',','.'));
  return Number.isFinite(amount) ? amount : null;
}
function extractVisibleFlightCards(root = document) {
  return [...root.querySelectorAll('[data-flight-result]')].map(card => {
    const field = name => card.querySelector(`[data-field="${name}"]`)?.textContent.trim() ?? '';
    return {
      from: card.dataset.from,
      to: card.dataset.to,
      date: card.dataset.date,
      carrier: field('carrier'),
      departureTime: field('depart'),
      arrivalTime: field('arrive'),
      baseFareEUR: euro(field('price')),
      cabinBagFeeEUR: euro(field('bag')),
      source: 'MOCK DATA — not a real ticket'
    };
  });
}
document.getElementById('extract').addEventListener('click', () => {
  document.getElementById('output').textContent = JSON.stringify(extractVisibleFlightCards(), null, 2);
});
