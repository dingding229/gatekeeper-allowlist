import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createRepository } from "../src/repository.js";

const setup = () => {
  const db = openDatabase(":memory:");
  return { db, repository: createRepository(db) };
};

test("the fourth unique network evicts the first network", () => {
  const { db, repository } = setup();
  const user = repository.createUser("alice");
  repository.addIp(user.id, "10.0.1.0/24", 4);
  repository.addIp(user.id, "10.0.2.0/24", 4);
  repository.addIp(user.id, "10.0.3.0/24", 4);
  const result = repository.addIp(user.id, "10.0.4.0/24", 4);

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
  repository.addIp(user.id, "2001:db8:1::/64", 6);
  repository.addIp(user.id, "2001:db8:2::/64", 6);

  const result = repository.addIp(user.id, "2001:db8:1::/64", 6);
  assert.equal(result.status, "existing");
  assert.equal(repository.listUserIps(user.id).length, 2);

  repository.addIp(user.id, "2001:db8:3::/64", 6);
  const fourth = repository.addIp(user.id, "2001:db8:4::/64", 6);
  assert.equal(fourth.evicted, "2001:db8:1::/64");
  db.close();
});

test("users own independent three-slot allowlists", () => {
  const { db, repository } = setup();
  const alice = repository.createUser("alice");
  const bob = repository.createUser("bob");

  for (let index = 1; index <= 4; index += 1) {
    repository.addIp(alice.id, `10.0.${index}.0/24`, 4);
  }
  repository.addIp(bob.id, "192.0.2.0/24", 4);

  assert.equal(repository.listUserIps(alice.id).length, 3);
  assert.deepEqual(
    repository.listUserIps(bob.id).map((row) => row.ip),
    ["192.0.2.0/24"],
  );
  db.close();
});
