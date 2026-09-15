// Read-modify-write the whole board under the lock: the operation that loses
// updates if the lock doesn't work. One worker per process.
import { createStore } from '../../lib/store.js';

const [root, id] = process.argv.slice(2);
const store = createStore(root);

// The product default gives up after 10s, which is right for a person at a
// terminal. This fixture deliberately creates contention a real user would not,
// and a shared CI runner can stretch eight concurrent writers well past that —
// so the worker takes its ceiling from the environment. The lock behaviour under
// test is "no write is lost", not "the ceiling is 10s".
const giveUpMs = Number(process.env.GW_TEST_LOCK_GIVEUP_MS ?? 10000);

store.withLock(() => {
  const items = store.readItems();
  items.push({ id, stage: 'backlog' });
  store.writeItems(items);
  store.appendEvent({ type: 'add', item: id, by: 'human:worker' });
}, { giveUpMs });
