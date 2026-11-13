// Populate each airport select only once. A synced airport directory can hold
// thousands of entries; rebuilding three <select>s on every Apply click used
// to stall the side panel's main thread even when the AI was already finished.
const initializedSelects = new WeakMap();

export function updateAirportSelect(select, airports, selected, { allowEmpty = false } = {}) {
  let state = initializedSelects.get(select);
  if (!state) {
    const doc = select.ownerDocument;
    const fragment = doc.createDocumentFragment();
    if (allowEmpty) {
      const none = doc.createElement('option');
      none.value = '';
      none.textContent = 'No specific stop';
      fragment.append(none);
    }
    for (const [code, name] of Object.entries(airports)) {
      const option = doc.createElement('option');
      option.value = code;
      option.textContent = `${name} (${code})`;
      fragment.append(option);
    }
    select.replaceChildren(fragment);
    state = { missingOption: null };
    initializedSelects.set(select, state);
  }

  // Preserve the old behavior for an AI-provided code outside the local data.
  // Do not accumulate stale fallback options when the user changes trips.
  if (state.missingOption && state.missingOption.value !== selected) {
    state.missingOption.remove();
    state.missingOption = null;
  }
  if (selected && !Object.hasOwn(airports, selected) && !state.missingOption) {
    const unknown = select.ownerDocument.createElement('option');
    unknown.value = selected;
    unknown.textContent = `${selected} (not in local airport directory)`;
    select.append(unknown);
    state.missingOption = unknown;
  }
  select.value = selected || '';
}
