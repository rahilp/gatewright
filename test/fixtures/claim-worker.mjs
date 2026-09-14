// Read-modify-write the whole board under the lock: the operation that loses
// updates if the lock doesn't work. One worker per process.
import { createStore } from '../../lib/store.js';

const [root, id] = process.argv.slice(2);
const store = createStore(root);

store.withLock(() => {
  const items = store.readItems();
  items.push({ id, stage: 'backlog' });
  store.writeItems(items);
  store.appendEvent({ type: 'add', item: id, by: 'human:worker' });
});
