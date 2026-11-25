import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(path, 'utf8');

test('Hindi labels are defined and used by the requested UI', () => {
  const hi = JSON.parse(read('lib/i18n/dictionaries/hi.json'));
  for (const key of ['customers.newCustomer', 'labels.sampleItem', 'common.close', 'toast.notifications']) {
    assert.match(hi[key] || '', /[\u0900-\u097f]/, key);
  }
  assert.match(read('components/customers/add-customer-dialog.tsx'), /t\("customers\.newCustomer"\)/);
  assert.match(read('app/(dashboard)/labels/page.tsx'), /t\("labels\.sampleItem"\)/);
  assert.match(read('components/ui/dialog.tsx'), /t\("common\.close"\)/);
  assert.match(read('components/ui/sonner.tsx'), /t\("toast\.notifications"\)/);
  assert.doesNotMatch(read('components/layout/mobile-bottom-nav.tsx'), /max-w-full truncate px-1/);
});
