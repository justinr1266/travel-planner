import test from 'node:test';
import assert from 'node:assert/strict';
import { updateAirportSelect } from '../airport-select.mjs';

// Minimal DOM double: checks option creation and retention without requiring
// jsdom or a live Chrome window in the existing node:test suite.
function makeSelect() {
  const counts = { optionCreates: 0, replacements: 0 };
  const document = {
    createDocumentFragment() {
      return { nodes: [], append(node) { this.nodes.push(node); } };
    },
    createElement(tag) {
      assert.equal(tag, 'option');
      counts.optionCreates++;
      return { value: '', textContent: '', parent: null, remove() {
        if (this.parent) {
          this.parent.nodes.splice(this.parent.nodes.indexOf(this), 1);
          this.parent = null;
        }
      } };
    }
  };
  const select = {
    ownerDocument: document, nodes: [], _value: '',
    replaceChildren(fragment) {
      this.nodes = [...fragment.nodes];
      this.nodes.forEach(n => { n.parent = this; });
      counts.replacements++;
    },
    append(option) { this.nodes.push(option); option.parent = this; },
    get value() { return this._value; },
    set value(v) { this._value = this.nodes.some(n => n.value === v) ? v : ''; }
  };
  return { select, counts };
}

test('applying AI details changes selection without rebuilding airport dropdowns', () => {
  const airports = { BCN: 'Barcelona', MAD: 'Madrid', ARN: 'Stockholm' };
  const {select, counts} = makeSelect();
  updateAirportSelect(select, airports, 'BCN');
  assert.equal(select.value, 'BCN');
  assert.equal(counts.replacements, 1);
  const created = counts.optionCreates;
  updateAirportSelect(select, airports, 'MAD');
  updateAirportSelect(select, airports, 'ARN');
  assert.equal(select.value, 'ARN');
  assert.equal(counts.replacements, 1);
  assert.equal(counts.optionCreates, created);
});

test('preferred destination retains an empty choice and recognizes unknown airports', () => {
  const airports = { BCN: 'Barcelona', MAD: 'Madrid' };
  const { select, counts } = makeSelect();
  updateAirportSelect(select, airports, '', {allowEmpty: true});
  assert.equal(select.value, '');
  assert.equal(select.nodes[0].textContent, 'No specific stop');
  updateAirportSelect(select, airports, 'XYZ', {allowEmpty: true});
  assert.equal(select.value, 'XYZ');
  assert.ok(select.nodes.some(n => /not in local airport directory/.test(n.textContent)));
  updateAirportSelect(select, airports, 'MAD', {allowEmpty: true});
  assert.equal(select.value, 'MAD');
  assert.ok(!select.nodes.some(n => n.value === 'XYZ'));
  assert.equal(counts.replacements, 1);
});

test('large airport catalog only creates option nodes once across repeated Apply actions', () => {
  const airports = Object.fromEntries(Array.from({ length: 6200 }, (_, i) =>
    [`T${String(i).padStart(4, '0')}`, `Airport ${i}`]));
  const {select, counts} = makeSelect();
  updateAirportSelect(select, airports, 'T0000');
  for (let i = 1; i <= 25; i++) {
    updateAirportSelect(select, airports, `T${String(i).padStart(4, '0')}`);
  }
  assert.equal(counts.optionCreates, 6200);
  assert.equal(counts.replacements, 1);
  assert.equal(select.value, 'T0025');
});
