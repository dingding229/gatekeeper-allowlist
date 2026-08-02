import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createRepository } from "../src/repository.js";

const setup = () => {
  const db = openDatabase(":memory:");
  return { db, repository: createRepository(db) };
};

const add = (repository, userId, network, family) =>
  repository.addIp(userId, network.split("/")[0], network, family);

test("the fourth unique network evicts the first network", () => {
  const { db, repository } = setup();
  const user = repository.createUser("alice");
  add(repository, user.id, "10.0.1.0/24", 4);
  add(repository, user.id, "10.0.2.0/24", 4);
  add(repository, user.id, "10.0.3.0/24", 4);
  const result = add(repository, user.id, "10.0.4.0/24", 4);

  assert.equal(result.evicted, "10.0.1.0/24");
  assert.deepEqual(
    repository.listUserIps(user.id).map((row) => row.ip),
    ["10.0.2.0/24", "10.0.3.0/24", "10.0.4.0/24"],
  );
  db.close();
});

test("reposting an existing network is idempotent and preserves FIFO", () => {
  const { db, repository } = setup();
  const user = repository.createUser("bob");
  add(repository, user.id, "2001:db8:1::/64", 6);
  add(repository, user.id, "2001:db8:2::/64", 6);

  const result = add(repository, user.id, "2001:db8:1::/64", 6);
  assert.equal(result.status, "existing");
  assert.equal(repository.listUserIps(user.id).length, 2);

  add(repository, user.id, "2001:db8:3::/64", 6);
  const fourth = add(repository, user.id, "2001:db8:4::/64", 6);
  assert.equal(fourth.evicted, "2001:db8:1::/64");
  db.close();
});

test("users own independent three-slot allowlists", () => {
  const { db, repository } = setup();
  const alice = repository.createUser("alice");
  const bob = repository.createUser("bob");

  for (let index = 1; index <= 4; index += 1) {
    add(repository, alice.id, `10.0.${index}.0/24`, 4);
  }
  add(repository, bob.id, "192.0.2.0/24", 4);

  assert.equal(repository.listUserIps(alice.id).length, 3);
  assert.deepEqual(
    repository.listUserIps(bob.id).map((row) => row.ip),
    ["192.0.2.0/24"],
  );
  db.close();
});

test("per-user limits evict old networks while history is preserved", () => {
  const { db, repository } = setup();
  const user = repository.createUser("custom-limit");
  repository.setUserLimit(user.id, 2);
  add(repository, user.id, "8.8.8.0/24", 4);
  add(repository, user.id, "1.1.1.0/24", 4);
  const third = add(repository, user.id, "9.9.9.0/24", 4);

  assert.equal(third.limit, 2);
  assert.equal(third.evicted, "8.8.8.0/24");
  assert.equal(repository.listUserIps(user.id).length, 2);
  assert.equal(repository.listUserHistory(user.id).length, 3);

  const lowered = repository.setUserLimit(user.id, 1);
  assert.deepEqual(lowered.evicted, ["1.1.1.0/24"]);
  assert.deepEqual(
    repository.listUserIps(user.id).map((row) => row.ip),
    ["9.9.9.0/24"],
  );

  repository.updateHistoryLocation(third.historyId, {
    country: "US",
    region: "New York",
    city: "New York",
    isp: "Quad9",
  });
  assert.equal(repository.listUserIps(user.id)[0].isp, "Quad9");
  assert.equal(repository.clearUserIps(user.id), 1);
  assert.equal(repository.listUserHistory(user.id).length, 3);
  db.close();
});

test("API rate limit is atomic per user", () => {
  const { db, repository } = setup();
  const alice = repository.createUser("rate-alice");
  const bob = repository.createUser("rate-bob");

  assert.equal(
    repository.consumeApiRequest(alice.id, 1_000, 60_000).allowed,
    true,
  );
  const blocked = repository.consumeApiRequest(alice.id, 1_001, 60_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 60);
  assert.equal(
    repository.consumeApiRequest(bob.id, 1_001, 60_000).allowed,
    true,
  );
  assert.equal(
    repository.consumeApiRequest(alice.id, 61_000, 60_000).allowed,
    true,
  );
  db.close();
});

test("a later report without metadata preserves the last known IP location", () => {
  const { db, repository } = setup();
  const user = repository.createUser("geo-history");
  const first = repository.addIp(user.id, "8.8.8.8", "8.8.8.0/24", 4, "surge");
  repository.updateHistoryLocation(first.historyId, {
    country: "美国",
    city: "Mountain View",
    isp: "Example ISP",
    source: "ipcheck.ing",
  });
  repository.addIp(user.id, "8.8.8.9", "8.8.8.0/24", 4, "api");

  const [active] = repository.listUserIps(user.id);
  assert.equal(active.observed_ip, "8.8.8.9");
  assert.equal(active.city, "Mountain View");
  assert.equal(active.geo_source, "ipcheck.ing");
  db.close();
});
