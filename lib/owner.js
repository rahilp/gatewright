// One definition of "is this the same owner". Owner strings arrive from two
// directions that never agreed: `gw claim <id>` without --by stores the
// qualified default actor ("human:rahil"), while `gw claim <id> --by rahil`
// stores the bare name the human typed. An exact-string comparison treats
// those as two different people, which is how guard came to refuse a commit
// from the very person who claimed the item.
//
// The rule: two owners are the same person when their names match and at
// least one of them is unqualified. When BOTH carry a qualifier, the
// qualifiers must agree -- "human:rahil" and "agent:rahil" are deliberately
// different actors (provenance is the point of the prefix), so neither may
// stand in for the other.
const QUALIFIED = /^(human|agent):(.+)$/;

function parse(owner) {
  const match = QUALIFIED.exec(String(owner ?? ''));
  return match ? { qualifier: match[1], name: match[2] } : { qualifier: null, name: String(owner ?? '') };
}

export function sameOwner(a, b) {
  if (!a || !b) return false;
  const left = parse(a);
  const right = parse(b);
  if (left.name !== right.name) return false;
  return left.qualifier === null || right.qualifier === null || left.qualifier === right.qualifier;
}
