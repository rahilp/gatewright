## P1 — sample phase for import parser tests

- **P1-01** · No deps em dash · feature · G0 · — · Simple scope.
- **P1-02** · No deps hyphen · feature · G0 · - · Simple scope.
- **P1-03** · One dependency item · feature · G0 · P1-01 · Depends on one.
- **P1-04** · Many dependencies item · test · G0 · P1-01, P1-02, P1-04.1 · Covers multiple deps and a child id.
- **P1-04.1** · Child item · feature · G0 · — · Child id survives unchanged.
- **P1-05** · Scope with separator inside backticks · doc · G0 · — · The `foo · bar` case.
- **P1-06** · Verified by checkmark · feature · G0 · — · Scope ends with ✅
- **P1-07** · Decided item · decision · G0 · — · **Decided:** we will use this.
- **P1-08** · Malformed line · feature · G0 · no separator here
