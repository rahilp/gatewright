// Read-modify-write the whole board under the lock: the operation that loses
// updates if the lock doesn't work. One worker per process.
import { createStore } from '../../lib/store.js';

const [root, id] = process.argv.slice(2);

// This is a subprocess helper, not a test — but `node --test` with no paths
// discovers every file under test/, runs this one with no argv, and reports a
// failure that is not real. Two agents have now reported it as a pre-existing
// breakage. Exit quietly when invoked without arguments so the false signal
// cannot mask a true one.
if (!root || !id) process.exit(0);
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
